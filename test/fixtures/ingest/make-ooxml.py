#!/usr/bin/env python3
"""Build the OOXML fixtures for the L3 ingest tests.

Run once; the outputs are committed. Regenerating must produce byte-identical
files, so every timestamp inside the archives is pinned.

    python3 test/fixtures/ingest/make-ooxml.py
"""
import os
import struct
import zipfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
FIXED_DATE = (2026, 1, 1, 0, 0, 0)


def png(width, height, rgb):
    """A solid-colour PNG, built by hand so the fixture has no dependencies."""
    raw = b''.join(b'\x00' + bytes(rgb) * width for _ in range(height))

    def chunk(tag, data):
        body = tag + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', ihdr)
            + chunk(b'IDAT', zlib.compress(raw, 9))
            + chunk(b'IEND', b''))


def write(path, files):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, data in files:
            info = zipfile.ZipInfo(name, date_time=FIXED_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o600 << 16
            z.writestr(info, data)


CT_DOCX = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>'''

ROOT_RELS_DOCX = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>'''

CORE = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">
<dc:title>Northwind Field Guide</dc:title>
<dc:creator>Dana Reyes</dc:creator>
<dc:language>en-GB</dc:language>
<dcterms:created>2026-01-01T00:00:00Z</dcterms:created>
</cp:coreProperties>'''

DOC_RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://northwind.example/pricing" TargetMode="External"/>
</Relationships>'''

STYLES = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="IntenseQuote"><w:name w:val="Intense Quote"/></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/></w:style>
</w:styles>'''

NUMBERING = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>'''


def p(text, style=None, num=None, bold=False, extra=''):
    ppr = ''
    if style or num:
        ppr = '<w:pPr>'
        if style:
            ppr += '<w:pStyle w:val="%s"/>' % style
        if num:
            ppr += '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="%s"/></w:numPr>' % num
        ppr += '</w:pPr>'
    rpr = '<w:rPr><w:b/></w:rPr>' if bold else ''
    run = '<w:r>%s<w:t xml:space="preserve">%s</w:t></w:r>' % (rpr, text) if text else ''
    return '<w:p>%s%s%s</w:p>' % (ppr, run, extra)


def cell(text, bold=False):
    return '<w:tc><w:tcPr/>%s</w:tc>' % p(text, bold=bold)


DRAWING = ('<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">'
           '<wp:extent cx="914400" cy="914400"/>'
           '<wp:docPr id="1" name="Picture 1" descr="Northwind wordmark on a dark field"/>'
           '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData>'
           '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill>'
           '<a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId3"/>'
           '</pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>')

HYPERLINK_P = ('<w:p><w:hyperlink r:id="rId4"><w:r><w:t>See the pricing page</w:t></w:r></w:hyperlink></w:p>')

DOCUMENT = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>
''' + p('Northwind Field Guide', style='Title') + p('How the team positions the platform in a first meeting.') + p('Positioning', style='Heading1') + p('Northwind sells into regulated operations teams. The buyer is rarely the user, and the user is rarely in the room.') + p('What we say first', style='Heading2') + p('Start with the audit trail.', num='1') + p('Show the approval chain second.', num='1') + p('Never lead with the integrations list.', num='1') + p('Sequence for the demo', style='Heading2') + p('Open with their own content.', num='2') + p('Branch on the compliance objection.', num='2') + p('Close on the approval chain.', num='2') + '''
<w:tbl><w:tblPr/><w:tblGrid/>
<w:tr><w:trPr><w:tblHeader/></w:trPr>''' + cell('Segment', bold=True) + cell('Primary objection', bold=True) + cell('Branch', bold=True) + '''</w:tr>
<w:tr>''' + cell('Regulated ops') + cell('Our situation is different') + cell('locale-fanout') + '''</w:tr>
<w:tr>''' + cell('Central marketing') + cell('Who approves this') + cell('approval-chain') + '''</w:tr>
</w:tbl>
''' + p('&#8220;The proof has to be built on their content, or it is a slideshow.&#8221;', style='IntenseQuote') + '<w:p>' + DRAWING + '</w:p>' + HYPERLINK_P + '''
<w:sectPr/>
</w:body></w:document>'''

write(os.path.join(HERE, 'sample.docx'), [
    ('[Content_Types].xml', CT_DOCX),
    ('_rels/.rels', ROOT_RELS_DOCX),
    ('docProps/core.xml', CORE),
    ('word/_rels/document.xml.rels', DOC_RELS),
    ('word/document.xml', DOCUMENT),
    ('word/styles.xml', STYLES),
    ('word/numbering.xml', NUMBERING),
    ('word/media/image1.png', png(6, 4, (11, 18, 32))),
])

# ---------------------------------------------------------------------------
# .pptx
# ---------------------------------------------------------------------------

CT_PPTX = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
<Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
<Override PartName="/ppt/slides/slide10.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
<Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>'''

ROOT_RELS_PPTX = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>'''

CORE_PPTX = CORE.replace('Northwind Field Guide', 'Northwind Quarterly Review')

PRESENTATION = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<p:sldIdLst>
<p:sldId id="256" r:id="rId1"/>
<p:sldId id="257" r:id="rId2"/>
<p:sldId id="258" r:id="rId3"/>
</p:sldIdLst>
<p:sldSz cx="12192000" cy="6858000"/>
</p:presentation>'''

PRESENTATION_RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide10.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
</Relationships>'''

NS = ('xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"')


def sp(name, ph, paragraphs, x, y):
    body = ''
    for text, lvl, bullet in paragraphs:
        ppr = ''
        attrs = ' lvl="%d"' % lvl if lvl else ''
        if bullet == 'none':
            ppr = '<a:pPr%s><a:buNone/></a:pPr>' % attrs
        elif bullet == 'auto':
            ppr = '<a:pPr%s><a:buAutoNum type="arabicPeriod"/></a:pPr>' % attrs
        elif bullet == 'char':
            ppr = '<a:pPr%s><a:buChar char="&#8226;"/></a:pPr>' % attrs
        elif attrs:
            ppr = '<a:pPr%s/>' % attrs
        body += '<a:p>%s<a:r><a:t>%s</a:t></a:r></a:p>' % (ppr, text)
    phxml = '<p:ph type="%s"/>' % ph if ph else ''
    return ('<p:sp><p:nvSpPr><p:cNvPr id="2" name="%s"/><p:cNvSpPr/><p:nvPr>%s</p:nvPr></p:nvSpPr>'
            '<p:spPr><a:xfrm><a:off x="%d" y="%d"/><a:ext cx="8000000" cy="2000000"/></a:xfrm></p:spPr>'
            '<p:txBody><a:bodyPr/><a:lstStyle/>%s</p:txBody></p:sp>') % (name, phxml, x, y, body)


SLIDE1 = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld %s><p:cSld><p:spTree>' % NS
          + sp('Body', 'body', [('Built on the prospect’s own content', 0, 'char'),
                                ('Branchable at the objection', 0, 'char'),
                                ('Offline, single file', 1, 'char')], 838200, 2000000)
          + sp('Title 1', 'title', [('Why a proof beats a demo', 0, 'none')], 838200, 400000)
          + '</p:spTree></p:cSld></p:sld>')

SLIDE1_RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
</Relationships>'''

NOTES1 = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:notes %s><p:cSld><p:spTree>' % NS
          + sp('Notes Placeholder', 'body', [('Do not read the bullets aloud. Ask what breaks first.', 0, 'none')], 0, 0)
          + '</p:spTree></p:cSld></p:notes>')

PIC = ('<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture 2" descr="Approval chain diagram"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>'
       '<p:blipFill><a:blip r:embed="rId1"/></p:blipFill>'
       '<p:spPr><a:xfrm><a:off x="838200" y="3000000"/><a:ext cx="4000000" cy="2000000"/></a:xfrm></p:spPr></p:pic>')

TABLE = ('<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Table 1"/></p:nvGraphicFramePr>'
         '<p:xfrm><a:off x="838200" y="5000000"/><a:ext cx="4000000" cy="1000000"/></p:xfrm>'
         '<a:graphic><a:graphicData><a:tbl><a:tblPr firstRow="1"/>'
         '<a:tr><a:tc><a:txBody><a:p><a:r><a:t>Stage</a:t></a:r></a:p></a:txBody></a:tc>'
         '<a:tc><a:txBody><a:p><a:r><a:t>Owner</a:t></a:r></a:p></a:txBody></a:tc></a:tr>'
         '<a:tr><a:tc><a:txBody><a:p><a:r><a:t>Legal review</a:t></a:r></a:p></a:txBody></a:tc>'
         '<a:tc><a:txBody><a:p><a:r><a:t>Priya</a:t></a:r></a:p></a:txBody></a:tc></a:tr>'
         '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>')

SLIDE10 = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld %s><p:cSld><p:spTree>' % NS
           + sp('Title 1', 'title', [('Who approves this', 0, 'none')], 838200, 400000)
           + PIC + TABLE
           + '</p:spTree></p:cSld></p:sld>')

SLIDE10_RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
</Relationships>'''

SLIDE2 = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld %s><p:cSld><p:spTree>' % NS
          + sp('Title 1', 'title', [('What we do next', 0, 'none')], 838200, 400000)
          + sp('Body', 'body', [('Draft the spine', 0, 'auto'),
                                ('Wire three branches', 0, 'auto'),
                                ('Rehearse to a clean pass', 0, 'auto')], 838200, 2000000)
          + '</p:spTree></p:cSld></p:sld>')

write(os.path.join(HERE, 'sample.pptx'), [
    ('[Content_Types].xml', CT_PPTX),
    ('_rels/.rels', ROOT_RELS_PPTX),
    ('docProps/core.xml', CORE_PPTX),
    ('ppt/_rels/presentation.xml.rels', PRESENTATION_RELS),
    ('ppt/presentation.xml', PRESENTATION),
    ('ppt/slides/_rels/slide1.xml.rels', SLIDE1_RELS),
    ('ppt/slides/_rels/slide10.xml.rels', SLIDE10_RELS),
    ('ppt/slides/slide1.xml', SLIDE1),
    ('ppt/slides/slide2.xml', SLIDE2),
    ('ppt/slides/slide10.xml', SLIDE10),
    ('ppt/notesSlides/notesSlide1.xml', NOTES1),
    ('ppt/media/image1.png', png(8, 6, (59, 46, 234))),
])

for f in ('sample.docx', 'sample.pptx'):
    print(f, os.path.getsize(os.path.join(HERE, f)), 'bytes')
