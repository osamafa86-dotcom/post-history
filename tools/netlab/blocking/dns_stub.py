"""محلّل DNS ثابت لمحاكاة الحجب في netlab (ADR 0011): سجلات A من DNS_RECORDS ("name=ip,name=ip")، وNXDOMAIN لغيرها.
الحجب نفسه لا يجري هنا بل على مسار العميل (iptables في حاوية العميل)، كما يفعل الحجب الشبكي الحقيقي.
"""
import os
import socket
import struct

RECORDS = dict(kv.split("=", 1) for kv in os.environ["DNS_RECORDS"].split(","))


def qname(data, i=12):
    labels = []
    while data[i]:
        n = data[i]
        labels.append(data[i + 1:i + 1 + n].decode())
        i += 1 + n
    return ".".join(labels).lower(), i + 5  # null byte + QTYPE + QCLASS


def answer(data):
    tid = data[:2]
    name, end = qname(data)
    qtype = struct.unpack(">H", data[end - 4:end - 2])[0]
    question = data[12:end]
    ip = RECORDS.get(name) if qtype == 1 else None
    flags = 0x8180 if ip else 0x8183  # response, RD+RA; rcode 0 or 3 (NXDOMAIN)
    head = tid + struct.pack(">HHHHH", flags, 1, 1 if ip else 0, 0, 0)
    if not ip:
        return head + question
    rr = b"\xc0\x0c" + struct.pack(">HHIH", 1, 1, 30, 4) + socket.inet_aton(ip)
    return head + question + rr


if __name__ == "__main__":
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("0.0.0.0", 53))
    while True:
        data, addr = s.recvfrom(512)
        try:
            s.sendto(answer(data), addr)
        except (IndexError, struct.error, UnicodeDecodeError):
            continue
