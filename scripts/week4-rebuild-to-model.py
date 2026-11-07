"""
Rebuild Week 4 deck to SEE → FEEL → CRAFT → STORY (not a label reskin).
COPY only. Outputs a true .pptx (macros stripped) for review.
"""
from __future__ import annotations

import re
import shutil
import zipfile
from io import BytesIO
from pathlib import Path

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE

SRC = Path(r"G:\Dropbox\alan ranger photography\Modules\Beginners Course\week 4 composition.pptm")
OUT_NAME = "week 4 composition SEE-FEEL-CRAFT-STORY-MODEL.pptx"
DESTS = [
    Path(r"G:\Dropbox\alan ranger photography\Modules\Beginners Course") / OUT_NAME,
    Path(r"C:\Users\alan\Google Drive\Claude shared resources\Powerpoints") / OUT_NAME,
    Path(r"C:\Users\alan\Google Drive\Claude shared resources\Cursor Outputs for Claude")
    / "Week4-Composition-SEE-FEEL-CRAFT-STORY-MODEL.pptx",
]

# Exact workbook framing for dividers / model
SEE_LINE = "SEE — observe, and choose what to leave out"
FEEL_LINE = "FEEL — your intention and the story"
CRAFT_LINE = "CRAFT — light, tone, contrast and colour; technique in service, last"
STORY_LINE = "STORY — where all three meet — the camera serves the feeling"
FIELD_TITLE = "IN THE FIELD — your 10-point checklist"

# Title patterns: longer first
TITLE_REPLACEMENTS = [
    ("Design – Composition Checklist:", FIELD_TITLE),
    ("Design – Composition Checklist", FIELD_TITLE),
    ("Design – Subject – Focal Point", "SEE · Focal Point"),
    ("Design – Subject – Point of View", "SEE · Point of View"),
    ("Design – Subject - Framing", "SEE · Framing"),
    ("Design – Subject – Subject Placement", "SEE · Subject Placement"),
    ("Design – Subject – Camera Craft", "SEE · Camera Craft"),
    ("Design – Subject – Lines and Patterns", "SEE · Lines and Patterns"),
    ("Design – Subject – Lines, Patterns & Symmetry - Balance", "SEE · Lines, Patterns & Symmetry"),
    ("Design – Subject – Direction and Flow", "SEE · Direction and Flow"),
    ("Design – Subject – Balance", "SEE · Balance"),
    ("Design – Subject –", "SEE · "),
    ("Design – Subject -", "SEE · "),
    ("Design - Subject", "SEE"),
    ("Design – Narrative – Literal Interpretations", "FEEL · Literal Interpretations"),
    ("Design – Narrative – Illustrative Interpretations", "FEEL · Illustrative Interpretations"),
    ("Design – Narrative – Metaphorical Interpretations", "FEEL · Metaphorical Interpretations"),
    ("Design – Narrative – Logical Reasoning", "FEEL · Logical Reasoning"),
    ("Design – Narrative - Mystery", "FEEL · Mystery"),
    ("Design – Narrative –", "FEEL · "),
    ("Design – Narrative -", "FEEL · "),
    ("Design - Narrative", "FEEL"),
    ("Design - Light", "CRAFT"),
    ("Week 4 – Design", "Design — The Art & Science of Seeing"),
    ("Week 4 - Design", "Design — The Art & Science of Seeing"),
    ("Composition – Subject", "Composition – SEE"),
    ("Composition – Narrative – Commercial Photography", "Composition – FEEL"),
    ("Composition – Narrative", "Composition – FEEL"),
]


def iter_shapes(shapes):
    for sh in shapes:
        yield sh
        if sh.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from iter_shapes(sh.shapes)


def set_para_text(p, text: str) -> None:
    if p.runs:
        p.runs[0].text = text
        for r in p.runs[1:]:
            r.text = ""
    else:
        p.text = text


def replace_in_frame(tf, pairs) -> int:
    n = 0
    for p in tf.paragraphs:
        t = p.text
        nt = t
        for old, new in pairs:
            if old in nt:
                nt = nt.replace(old, new)
        if nt != t:
            set_para_text(p, nt)
            n += 1
    return n


def replace_exact_para(slide, old: str, new: str) -> int:
    n = 0
    for sh in iter_shapes(slide.shapes):
        if not sh.has_text_frame:
            continue
        for p in sh.text_frame.paragraphs:
            if p.text.strip() == old:
                set_para_text(p, new)
                n += 1
    return n


def replace_contains(slide, needle: str, new: str) -> int:
    n = 0
    for sh in iter_shapes(slide.shapes):
        if not sh.has_text_frame:
            continue
        for p in sh.text_frame.paragraphs:
            if needle in p.text:
                set_para_text(p, new)
                n += 1
    return n


def apply_global_titles(prs) -> int:
    n = 0
    for slide in prs.slides:
        for sh in iter_shapes(slide.shapes):
            if sh.has_text_frame:
                n += replace_in_frame(sh.text_frame, TITLE_REPLACEMENTS)
    return n


def rebuild_slide1(slide) -> int:
    n = 0
    n += replace_exact_para(slide, "Week 4 – Design", "Design — The Art & Science of Seeing")
    n += replace_exact_para(slide, "Week 4 - Design", "Design — The Art & Science of Seeing")
    return n


def rebuild_slide2(slide) -> int:
    """Next 4 weeks — Week 4 names See·Feel·Craft·Story."""
    n = 0
    pairs = [
        ("Week 4 - Design", "Week 4 — See · Feel · Craft · Story"),
        ("Week 4 – Design", "Week 4 — See · Feel · Craft · Story"),
        ("Subject", "SEE"),
        ("Narrative", "FEEL"),
        ("Light", "CRAFT"),
        ("Intention", "STORY"),
    ]
    # Only rewrite Week-4 block labels carefully via exact matches on short labels
    for sh in iter_shapes(slide.shapes):
        if not sh.has_text_frame:
            continue
        for p in sh.text_frame.paragraphs:
            t = p.text.strip()
            if t in ("Week 4 - Design", "Week 4 – Design"):
                set_para_text(p, "Week 4 — See · Feel · Craft · Story")
                n += 1
            elif t == "Subject":
                set_para_text(p, "SEE")
                n += 1
            elif t == "Narrative":
                set_para_text(p, "FEEL")
                n += 1
            elif t == "Light":
                set_para_text(p, "CRAFT")
                n += 1
            elif t == "Intention":
                set_para_text(p, "STORY")
                n += 1
            elif t == "Assignment Review":
                pass  # keep
    return n


def rebuild_slides_3_4(slides) -> int:
    s3, s4 = slides[2], slides[3]
    n = 0
    # Slide 3 — full model intro
    for sh in iter_shapes(s3.shapes):
        if not sh.has_text_frame:
            continue
        for p in sh.text_frame.paragraphs:
            t = p.text
            low = t.lower()
            nt = t
            if t.strip() == "Design":
                nt = "See → Feel → Craft → Story"
            elif "design stage of creating a photograph" in low:
                nt = (
                    "SEE → FEEL → CRAFT → STORY — "
                    "observe and choose what to leave out; form your intention; "
                    "then let light, tone and colour serve that feeling. "
                    "The camera serves the feeling. Craft comes last."
                )
            elif "3 critical visual building blocks" in low:
                nt = (
                    "Four stages of the model — SEE · FEEL · CRAFT → STORY "
                    "(from the workbook: The Art & Science of Seeing)"
                )
            elif t.strip().startswith("Subject"):
                nt = "SEE — observe, and choose what to leave out (subject, viewpoint, emptiness)"
            elif t.strip().startswith("Narrative"):
                nt = "FEEL — your intention and the story; why you're making the picture"
            elif t.strip().startswith("Light"):
                nt = "CRAFT — light, tone, contrast and colour; technique in service, last"
            elif "combine to convey" in low:
                nt = "STORY — where all three meet. The camera serves the feeling."
            elif "how affects composition" in low:
                nt = (
                    "The how affects composition but isn't the driver. "
                    "First see and feel — then craft. First compose, then expose."
                )
            if nt != t:
                set_para_text(p, nt)
                n += 1
    # Slide 4 — model overview (was lone "Design")
    for sh in iter_shapes(s4.shapes):
        if not sh.has_text_frame:
            continue
        for p in sh.text_frame.paragraphs:
            if p.text.strip() == "Design":
                set_para_text(
                    p,
                    "SEE · FEEL · CRAFT → STORY\n"
                    "observe · leave out  ·  intention · story  ·  light · tone · colour  →  the camera serves the feeling",
                )
                n += 1
    return n


def rebuild_dividers(prs) -> int:
    n = 0
    # Slide 5 Subject divider
    n += replace_exact_para(prs.slides[4], "Design", SEE_LINE)
    # Slide 16 Narrative divider title already "Design - Narrative" via global; reinforce
    n += replace_exact_para(prs.slides[15], "Design - Narrative", FEEL_LINE)
    n += replace_exact_para(prs.slides[15], "FEEL", FEEL_LINE)
    # Slide 18 secondary Design
    n += replace_exact_para(prs.slides[17], "Design", "FEEL")
    # Slide 27 Light
    n += replace_exact_para(prs.slides[26], "Design - Light", CRAFT_LINE)
    n += replace_exact_para(prs.slides[26], "CRAFT", CRAFT_LINE)
    return n


def rebuild_av_slides(prs) -> int:
    n = 0
    s15 = prs.slides[14]
    for sh in iter_shapes(s15.shapes):
        if not sh.has_text_frame:
            continue
        for p in sh.text_frame.paragraphs:
            t = p.text
            if "identify the use of" in t.lower() or "Watch the Audio Visual" in t:
                set_para_text(
                    p,
                    "Watch the Audio Visual — hopefully you will identify SEE "
                    "(observe, and choose what to leave out).",
                )
                n += 1
            elif t.strip() in ("Composition – Subject", "Composition – SEE"):
                set_para_text(p, "Composition – SEE")
                n += 1
            elif t.strip() in ("Design - Subject", "SEE"):
                if "Design" in t or t.strip() == "Design - Subject":
                    set_para_text(p, "SEE")
                    n += 1
    s25 = prs.slides[24]
    for sh in iter_shapes(s25.shapes):
        if not sh.has_text_frame:
            continue
        for p in sh.text_frame.paragraphs:
            t = p.text
            if "identify the use of Narrative" in t or "Watch the Audio Visual" in t:
                set_para_text(
                    p,
                    "Watch the Audio Visual — hopefully you will identify FEEL "
                    "(your intention and the story).",
                )
                n += 1
            elif "Design - Narrative" in t:
                set_para_text(p, "FEEL")
                n += 1
    return n


# Workbook-aligned tip lead lines (slides 39–48)
TIP_BODIES = {
    38: [  # slide 39 = index 38
        ("Take a good look at the real heart of your image. What one idea or relationship of elements can the image absolutely not work without?",
         "What one idea can the image not work without? Exclude all else — shallow depth of field, a longer lens, or your position can simplify the frame."),
        ("Find your one idea and exclude the rest.",
         "Find your one idea and exclude the rest."),
    ],
    39: [
        ("Ask yourself if the orientation of the frame reinforces the main direction or energy of the subject.",
         "Does the orientation reinforce the subject's energy? A vertical frame tells the viewer to read vertically. Go in the direction of the flow."),
    ],
    40: [
        ("How does your foreground relate to the background?",
         "How does foreground relate to background? Move to lose a distraction, get lower to separate the horizon, or get close with a wide lens to shrink the background."),
    ],
    41: [
        ("Take a moment, scan the frame. Is anything touching?",
         "Scan the frame. Is anything touching or clipped that shouldn't be? Could pulling back give more negative space and less distraction around the edges?"),
    ],
    42: [
        ("Every element in the frame has a certain amount of visual weight.",
         "Every element has visual weight. Drawn down the middle, do the important elements counterbalance? Some images work best imbalanced — but decide it with the camera in hand."),
    ],
    43: [
        ("The eye moves around a frame in much the same way we move around a room and, generally, we want that to be uninterrupted.",
         "The eye roams a frame like a room — keep it uninterrupted. Tight spots feel unwelcoming. Keeping key elements apart helps the eye keep exploring."),
    ],
    44: [
        ("Is energy an important part of your scene? Is the lack of energy, as in a serene landscape, more important?",
         "Is energy important, or is stillness? Too much tension hurts a serene scene; a square frame rarely suits a dynamic one. Use orientation, ratio, shutter, moment and colour to match."),
    ],
    45: [
        ("One of the things that makes a great image, that grabs our attention, and is an important element in storytelling, is contrast.",
         "Contrast grabs attention and drives story — and it's more than light/dark. Isolate the contrasting elements with lens, perspective, timing. Find the contrast, then exaggerate it."),
    ],
    46: [
        ("The best moments photographically are not only about when something happens, but where.",
         "The best moments are about when AND where. Place the moment in the frame so it means something, creates energy, or separates from the background."),
    ],
    47: [
        ("Every line in a photograph matters. It leads your eye or intersects with other lines to create shapes.",
         "Every line leads the eye or makes a shape. It's your position relative to the lines that places them. If the lines aren't doing what you want — move."),
    ],
}


def rebuild_checklist(prs) -> int:
    n = 0
    # Slide 37 top tips already close to workbook REMEMBER — leave body; retitle if needed
    # Slide 38 summary header
    for sh in iter_shapes(prs.slides[37].shapes):
        if not sh.has_text_frame:
            continue
        n += replace_in_frame(sh.text_frame, [("Design – Composition Checklist:", FIELD_TITLE)])
        n += replace_in_frame(sh.text_frame, [("Summary", "Run through these with the camera in your hand — before you press the shutter.")])
    for idx, pairs in TIP_BODIES.items():
        slide = prs.slides[idx]
        for sh in iter_shapes(slide.shapes):
            if not sh.has_text_frame:
                continue
            for p in sh.text_frame.paragraphs:
                t = p.text
                for old, new in pairs:
                    if t.strip() == old.strip() or (old in t and len(t) < len(old) + 40):
                        set_para_text(p, new)
                        n += 1
                        break
    return n


def rebuild_slide49_story(slide) -> int:
    """Replace See·Design·Shoot 30/50/10 entirely with STORY model."""
    n = 0
    # Collect all text paras and rewrite by role
    for sh in iter_shapes(slide.shapes):
        if not sh.has_text_frame:
            continue
        for p in sh.text_frame.paragraphs:
            raw = p.text
            if not raw.strip() or raw.strip().isdigit():
                continue
            low = raw.lower()
            nt = None
            if "see | design | shoot" in low:
                nt = "SEE → FEEL → CRAFT → STORY"
            elif "observe | compose | expose" in low:
                nt = STORY_LINE
            elif "step 1" in low or (low.startswith("see") and "30" in raw):
                nt = "SEE — observe, and choose what to leave out (subject, viewpoint, emptiness)"
            elif "step 2" in low or ("design" in low and "50" in raw):
                nt = "FEEL — your intention and the story; why you're making the picture"
            elif "step 3" in low or ("shoot" in low and "10" in raw):
                nt = "CRAFT — light, tone, contrast and colour; technique in service, last"
            elif "step 4" in low or (low.startswith("review") and "10" in raw):
                nt = "STORY — where all three meet. The camera serves the feeling."
            elif "observation and connection" in low:
                nt = "Pause. Observe. Survey. Notice light, background, distractions, space."
            elif "composition is key" in low:
                nt = "If your reason for the photo is unclear to you, that confusion shows in the image."
            elif "exposure settings can produce" in low:
                nt = "Technique comes last — deliberately. First compose, then expose."
            elif "check your histogram" in low:
                nt = "Craft serves the feeling — light, tone and colour in service of what you see and feel."
            elif "ability to get it right" in low:
                nt = "STORY — intention realised. The camera serves the feeling."
            # Clear leftover old teaching bullets under the triangle into short model lines
            elif any(
                x in low
                for x in (
                    "distance, viewpoint",
                    "survey your subject",
                    "cluttered backgrounds",
                    "texture, shape, form",
                    "vertical and horizontal",
                    "clear subject, focal",
                    "intruders",
                    "movement, dynamism",
                    "don't have to show the whole",
                    "focus on the closest",
                    "take note of the light",
                )
            ):
                nt = ""  # clear dense old triangle bullets
            if nt is not None and nt != raw:
                set_para_text(p, nt)
                n += 1
    return n


def pptm_to_pptx(src: Path, dest: Path) -> None:
    """Write a true .pptx by stripping VBA / macro content types from a .pptm."""
    buf = BytesIO(src.read_bytes())
    out_buf = BytesIO()
    with zipfile.ZipFile(buf, "r") as zin, zipfile.ZipFile(out_buf, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            name = info.filename
            if name.lower().endswith("vbaproject.bin"):
                continue
            data = zin.read(name)
            if name == "[Content_Types].xml":
                text = data.decode("utf-8")
                text = text.replace(
                    "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml",
                    "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
                )
                text = re.sub(
                    r'<Override[^>]*PartName="/ppt/vbaProject\.bin"[^>]*/>',
                    "",
                    text,
                )
                data = text.encode("utf-8")
            elif name == "ppt/_rels/presentation.xml.rels":
                text = data.decode("utf-8")
                text = re.sub(
                    r'<Relationship[^>]*Target="vbaProject\.bin"[^>]*/>',
                    "",
                    text,
                )
                data = text.encode("utf-8")
            zout.writestr(info, data)
    dest.write_bytes(out_buf.getvalue())


def main():
    assert SRC.exists(), SRC
    work = Path(r"C:\Users\alan\AppData\Local\Temp\week4-model-work.pptm")
    print("copy source -> work")
    shutil.copy2(SRC, work)

    print("opening…")
    prs = Presentation(str(work))
    total = 0
    total += apply_global_titles(prs)
    total += rebuild_slide1(prs.slides[0])
    total += rebuild_slide2(prs.slides[1])
    total += rebuild_slides_3_4(prs.slides)
    total += rebuild_dividers(prs)
    total += rebuild_av_slides(prs)
    total += rebuild_checklist(prs)
    total += rebuild_slide49_story(prs.slides[48])

    print("saving work pptm…", total, "edits")
    prs.save(str(work))

    for dest in DESTS:
        dest.parent.mkdir(parents=True, exist_ok=True)
        print("writing true pptx ->", dest)
        pptm_to_pptx(work, dest)
        # verify
        v = Presentation(str(dest))
        print("  slides", len(v.slides), "bytes", dest.stat().st_size)

    # quick spot-check
    check = Presentation(str(DESTS[0]))
    for i in [0, 2, 4, 14, 15, 26, 37, 48]:
        texts = []
        for sh in iter_shapes(check.slides[i].shapes):
            if sh.has_text_frame:
                for p in sh.text_frame.paragraphs:
                    t = p.text.strip()
                    if t and not t.isdigit():
                        texts.append(t[:100])
        print(f"S{i+1}:", " | ".join(texts[:4]))


if __name__ == "__main__":
    main()
