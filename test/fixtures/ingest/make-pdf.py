#!/usr/bin/env python3
"""Build the PDF fixtures for the L3 ingest tests.

Two files, because the two cross-reference mechanisms are different code paths
and both appear in documents a seller will actually drop in:

  sample.pdf      classic `xref` table, WinAnsi text, a Flate RGB image with an
                  SMask, and a DCTDecode JPEG lifted out whole.
  xrefstream.pdf  cross-reference *stream* plus an object stream, and a font
                  whose only route to characters is its `ToUnicode` CMap.

Run once; the outputs are committed.

    python3 test/fixtures/ingest/make-pdf.py
"""
import os
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))


def flate(data):
    return zlib.compress(data, 9)


class Builder:
    """Assembles a PDF body, tracking each object's byte offset."""

    def __init__(self):
        self.parts = [b'%PDF-1.7\n%\xe2\xe3\xcf\xd3\n']
        self.offsets = {}

    @property
    def size(self):
        return sum(len(p) for p in self.parts)

    def add(self, num, body):
        self.offsets[num] = self.size
        self.parts.append(b'%d 0 obj\n' % num + body + b'\nendobj\n')

    def stream(self, num, dict_body, data):
        head = b'<< ' + dict_body + b' /Length %d >>' % len(data)
        self.add(num, head + b'\nstream\n' + data + b'\nendstream')

    def bytes(self):
        return b''.join(self.parts)


def raw_rgb(width, height, pixel):
    return bytes(pixel) * width * height


# A 8x8 baseline JPEG, hand-assembled: SOI, APP0, DQT, SOF0, DHT, SOS, data, EOI.
# The importer lifts DCTDecode bytes out unchanged, so what matters for the test
# is that these bytes are a real JPEG and survive the round trip byte for byte.
JPEG = bytes.fromhex(
    'ffd8ffe000104a46494600010100000100010000'
    'ffdb004300ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    'ffffffffffff'
    'ffc0000b080008000801011100'
    'ffc4001f0000010501010101010100000000000000000102030405060708090a0b'
    'ffc400b5100002010303020403050504040000017d01020300041105122131410613516107'
    '227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a'
    '434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a'
    '92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9da'
    'e1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9fa'
    'ffda0008010100003f00d2cf20'
    'ffd9'
)

# ---------------------------------------------------------------------------
# sample.pdf — classic xref table
# ---------------------------------------------------------------------------

CONTENT1 = b'''BT
/F1 24 Tf
72 700 Td
(Northwind Field Guide) Tj
ET
BT
/F1 11 Tf
72 668 Td
[(Compile a prospect) -18 (\\222) -18 (s own content into a proof.)] TJ
ET
BT
/F1 11 Tf
72 654 Td
(A generic demo dies to the objection that our situation is different.) Tj
ET
BT
/F1 11 Tf
72 620 Td
(\\225 Start with the audit trail) Tj
ET
BT
/F1 11 Tf
72 604 Td
(\\225 Show the approval chain second) Tj
ET
q 200 0 0 100 72 460 cm /Im1 Do Q
q 120 0 0 90 300 460 cm /Im2 Do Q
'''

CONTENT2 = b'''BT
/F1 18 Tf
72 700 Td
(What the room actually asks) Tj
ET
BT
/F1 11 Tf
72 670 Td
(Who approves this, and what does the reviewer see when they open it?) Tj
ET
'''

b = Builder()
b.add(1, b'<< /Type /Catalog /Pages 2 0 R /Lang (en-GB) >>')
b.add(2, b'<< /Type /Pages /Kids [3 0 R 8 0 R] /Count 2 /MediaBox [0 0 612 792] '
         b'/Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R /Im2 7 0 R >> >> >>')
b.add(3, b'<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>')
b.stream(4, b'/Filter /FlateDecode', flate(CONTENT1))
b.add(5, b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
b.stream(
    6,
    b'/Type /XObject /Subtype /Image /Width 4 /Height 3 /ColorSpace /DeviceRGB '
    b'/BitsPerComponent 8 /SMask 11 0 R /Filter /FlateDecode',
    flate(raw_rgb(4, 3, (59, 46, 234))),
)
b.stream(
    7,
    b'/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB '
    b'/BitsPerComponent 8 /Filter /DCTDecode',
    JPEG,
)
b.add(8, b'<< /Type /Page /Parent 2 0 R /Contents 9 0 R >>')
b.stream(9, b'/Filter /FlateDecode', flate(CONTENT2))
b.add(10, b'<< /Title (Northwind Field Guide) /Author (Dana Reyes) '
          b'/Subject (How the team positions the platform) /Producer (PitchProof fixture) >>')
b.stream(
    11,
    b'/Type /XObject /Subtype /Image /Width 4 /Height 3 /ColorSpace /DeviceGray '
    b'/BitsPerComponent 8 /Filter /FlateDecode',
    flate(bytes([255, 255, 128, 0] * 3)),
)

body = b.bytes()
xref_offset = len(body)
count = max(b.offsets) + 1
lines = [b'xref\n', b'0 %d\n' % count, b'0000000000 65535 f \n']
for num in range(1, count):
    lines.append(b'%010d 00000 n \n' % b.offsets.get(num, 0))
trailer = (b''.join(lines)
           + b'trailer\n<< /Size %d /Root 1 0 R /Info 10 0 R >>\nstartxref\n%d\n%%%%EOF\n'
           % (count, xref_offset))
open(os.path.join(HERE, 'sample.pdf'), 'wb').write(body + trailer)

# ---------------------------------------------------------------------------
# xrefstream.pdf — cross-reference stream, object stream, ToUnicode CMap
# ---------------------------------------------------------------------------

# The font's codes are 1..N with no standard encoding meaning; only the
# ToUnicode CMap can turn them into characters.
PHRASE = 'PROOF NOT DEMO'
CODES = {}
for ch in PHRASE:
    if ch not in CODES:
        CODES[ch] = len(CODES) + 1

bfchars = ''.join('<%02X> <%04X>\n' % (code, ord(ch)) for ch, code in CODES.items())
CMAP = ('''/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CMapName /Custom def
/CMapType 2 def
1 begincodespacerange
<00> <FF>
endcodespacerange
%d beginbfchar
%sendbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end
''' % (len(CODES), bfchars)).encode('ascii')

hexcodes = ''.join('%02X' % CODES[ch] for ch in PHRASE)
CONTENT3 = ('BT\n/F1 20 Tf\n72 700 Td\n<%s> Tj\nET\n' % hexcodes).encode('ascii')

b2 = Builder()

# Objects 1, 2, 3 and 5 live inside an object stream; 4, 6, 7 and 8 do not.
packed = [
    (1, b'<< /Type /Catalog /Pages 2 0 R >>'),
    (2, b'<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] '
        b'/Resources << /Font << /F1 5 0 R >> >> >>'),
    (3, b'<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>'),
    (5, b'<< /Type /Font /Subtype /Type1 /BaseFont /AAAAAA+Custom /FirstChar 1 /LastChar %d '
        b'/Widths [%s] /ToUnicode 7 0 R >>' % (
            len(CODES), b' '.join(b'600' for _ in CODES))),
]
header = b''
payload = b''
for num, data in packed:
    header += b'%d %d ' % (num, len(payload))
    payload += data + b' '
objstm_data = header + payload

b2.stream(4, b'/Filter /FlateDecode', flate(CONTENT3))
b2.stream(6, b'/Type /ObjStm /N %d /First %d /Filter /FlateDecode' % (len(packed), len(header)),
          flate(objstm_data))
b2.stream(7, b'/Filter /FlateDecode', flate(CMAP))

# The cross-reference stream itself is object 8 and must know its own offset.
xref_pos = b2.size
entries = {
    0: (0, 0, 65535),
    1: (2, 6, 0),
    2: (2, 6, 1),
    3: (2, 6, 2),
    4: (1, b2.offsets[4], 0),
    5: (2, 6, 3),
    6: (1, b2.offsets[6], 0),
    7: (1, b2.offsets[7], 0),
    8: (1, xref_pos, 0),
}
rows = b''
for num in range(0, 9):
    kind, field2, field3 = entries[num]
    rows += bytes([kind]) + field2.to_bytes(4, 'big') + field3.to_bytes(2, 'big')
b2.stream(
    8,
    b'/Type /XRef /Size 9 /W [1 4 2] /Root 1 0 R /Filter /FlateDecode',
    flate(rows),
)
out = b2.bytes() + b'startxref\n%d\n%%%%EOF\n' % xref_pos
open(os.path.join(HERE, 'xrefstream.pdf'), 'wb').write(out)

for f in ('sample.pdf', 'xrefstream.pdf'):
    print(f, os.path.getsize(os.path.join(HERE, f)), 'bytes')
