//! Tiny embedded HTTP server used by zen probe / cache_stats tests.
//!
//! Each route is matched by exact path. Anything unmatched → 404.
//! An optional pre-response delay simulates a slow daemon for timeout tests.
//! Every accepted request path is recorded into a shared log so tests can
//! assert the URL-construction layer (e.g. that `/stats/z%24` was used, not
//! `/stats/z$`).

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

pub type Route = (u16, &'static str, Vec<u8>);

pub struct TestServer {
    port: u16,
    stop: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
    requests: Arc<Mutex<Vec<String>>>,
}

impl TestServer {
    pub fn new(routes: Vec<(&'static str, Route)>, response_delay: Duration) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = Arc::clone(&stop);
        let requests = Arc::new(Mutex::new(Vec::new()));
        let requests_clone = Arc::clone(&requests);
        let handle = thread::spawn(move || {
            serve_loop(listener, routes, response_delay, stop_clone, requests_clone);
        });
        TestServer {
            port,
            stop,
            handle: Some(handle),
            requests,
        }
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Snapshot of every request path the server has accepted so far.
    pub fn request_paths(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Wake the accept poll loop by attempting one connection.
        let _ = TcpStream::connect(("127.0.0.1", self.port));
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

fn serve_loop(
    listener: TcpListener,
    routes: Vec<(&'static str, Route)>,
    response_delay: Duration,
    stop: Arc<AtomicBool>,
    requests: Arc<Mutex<Vec<String>>>,
) {
    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        match listener.accept() {
            Ok((stream, _)) => {
                let routes = routes.clone();
                let requests = Arc::clone(&requests);
                thread::spawn(move || {
                    if !response_delay.is_zero() {
                        thread::sleep(response_delay);
                    }
                    let _ = handle_one(stream, &routes, &requests);
                });
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(5));
            }
            Err(_) => break,
        }
    }
}

fn handle_one(
    mut stream: TcpStream,
    routes: &[(&'static str, Route)],
    requests: &Mutex<Vec<String>>,
) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    // Drain headers
    loop {
        let mut hdr = String::new();
        let n = reader.read_line(&mut hdr)?;
        if n == 0 || hdr == "\r\n" || hdr == "\n" {
            break;
        }
    }
    // Parse path token (METHOD SP PATH SP VERSION)
    let path = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or("/")
        .to_string();
    requests.lock().unwrap().push(path.clone());
    let (status, content_type, body) = match routes.iter().find(|(p, _)| *p == path.as_str()) {
        Some((_, (status, ct, body))) => (*status, *ct, body.clone()),
        None => (404u16, "text/plain", b"not found".to_vec()),
    };
    let reason = match status {
        200 => "OK",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "Status",
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {ct}\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n",
        status = status,
        reason = reason,
        ct = content_type,
        len = body.len()
    );
    stream.write_all(header.as_bytes())?;
    stream.write_all(&body)?;
    stream.flush()?;
    // Allow the client to read before we drop the socket.
    let _ = stream.shutdown(std::net::Shutdown::Write);
    let mut sink = Vec::new();
    let _ = reader.read_to_end(&mut sink);
    Ok(())
}
