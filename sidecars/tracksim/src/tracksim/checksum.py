from __future__ import annotations


def fletcher16(data: bytes) -> int:
    """16-bit Fletcher checksum (modulus 256).

    Algorithm copied from camdkit opentrackio_lib.fletcher16; returns the
    16-bit value (sum2 << 8) | sum1 as an int.
    """
    sum1 = 0
    sum2 = 0
    for byte in data:
        sum1 = (sum1 + byte) % 256
        sum2 = (sum2 + sum1) % 256
    return (sum2 << 8) | sum1
