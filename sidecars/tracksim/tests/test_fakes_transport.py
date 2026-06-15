from tests.fakes import FakeTransport


def test_fake_transport_records_sent_bytes():
    t = FakeTransport()
    t.send(b"abc")
    t.send(b"def")
    assert t.sent == [b"abc", b"def"]


def test_fake_transport_close_sets_flag():
    t = FakeTransport()
    assert t.closed is False
    t.close()
    assert t.closed is True
