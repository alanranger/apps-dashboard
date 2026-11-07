"""
Rework Week 4 composition deck: Design/See-Design-Shoot → SEE·FEEL·CRAFT→STORY.
Works on a COPY only. Output .pptx for review.
"""
from __future__ import annotations

import shutil
from copy import deepcopy
from pathlib import Path

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE

SRC = Path(r"G:\Dropbox\alan ranger photography\Modules\Beginners Course\week 4 composition.pptm")
OUTBOX = Path(r"C:\Users\alan\Google Drive\Claude shared resources\Cursor Outputs for Claude")
OUT = OUTBOX / "Week4-Composition-SEE-FEEL-CRAFT-STORY-REVIEW.pptx"

# Longer patterns first.
REPLACEMENTS = [
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
    ("Design – Composition Checklist:", "CRAFT · Composition Checklist:"),
    ("Design – Composition Checklist", "CRAFT · Composition Checklist"),
    ("Design - Light", "CRAFT"),
    ("Week 4 – Design", "Week 4 · Composition"),
    ("Week 4 - Design", "Week 4 · Composition"),
    ("See 30% / Design 50% / Shoot 10%", "SEE 30% · FEEL 30% · CRAFT 30% → STORY"),
    ("Step 1 – See (30%) - Your eyes – your emotions – your intention",
     "SEE (30%) — observe · leave out · connect"),
    ("Step 2 – Design (50%) – Your ability to distil and decipher",
     "FEEL (30%) — intention · narrative · emotion"),
    ("Step 3 – Shoot (10%) - Your ability to execute",
     "CRAFT (30%) — light · tone · colour  →  STORY"),
    ("Step 1 – See (30%)", "SEE (30%)"),
    ("Step 2 – Design (50%)", "FEEL (30%)"),
    ("Step 3 – Shoot (10%)", "CRAFT (30%) → STORY"),
]


def iter_shapes(shapes):
    for sh in shapes:
        yield sh
        if sh.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from iter_shapes(sh.shapes)


def replace_in_text_frame(tf) -> int:
    n = 0
    # Whole-frame first (multi-run titles)
    full = "\n".join(p.text for p in tf.paragraphs)
    new_full = full
    for old, new in REPLACEMENTS:
        if old in new_full:
            new_full = new_full.replace(old, new)
            n += 1
    if new_full != full:
        # Rewrite paragraph by paragraph where possible
        for p in tf.paragraphs:
            if not p.runs and not p.text:
                continue
            t = p.text
            nt = t
            for old, new in REPLACEMENTS:
                if old in nt:
                    nt = nt.replace(old, new)
            if nt != t:
                if p.runs:
                    # Put all text in first run; clear others
                    p.runs[0].text = nt
                    for r in p.runs[1:]:
                        r.text = ""
                else:
                    p.text = nt
        return max(n, 1)

    # Per-run fallback
    for p in tf.paragraphs:
        for r in p.runs:
            t = r.text
            nt = t
            for old, new in REPLACEMENTS:
                if old in nt:
                    nt = nt.replace(old, new)
                    n += 1
            if nt != t:
                r.text = nt
    return n


def revoice_slide49(slide) -> int:
    """Force SEE·FEEL·CRAFT→STORY model on the old See/Design/Shoot summary."""
    n = 0
    for sh in iter_shapes(slide.shapes):
        if not sh.has_text_frame:
            continue
        for p in sh.text_frame.paragraphs:
            raw = p.text
            low = raw.lower()
            nt = raw
            if "see | design | shoot" in low:
                nt = "SEE | FEEL | CRAFT → STORY"
            elif "observe | compose | expose | review" in low:
                nt = "(observe · intention · light · review)"
            elif "step 1" in low or (low.strip().startswith("see") and "30" in raw):
                nt = "SEE (30%) — observe · leave out · connect"
            elif "step 2" in low or ("design" in low and "50" in raw):
                nt = "FEEL (30%) — intention · narrative · emotion"
            elif "step 3" in low or ("shoot" in low and "10" in raw):
                nt = "CRAFT (30%) — light · tone · colour  →  STORY"
            elif raw.strip() in ("See", "SEE"):
                nt = "SEE · FEEL · CRAFT → STORY"
            if nt != raw:
                if p.runs:
                    p.runs[0].text = nt
                    for r in p.runs[1:]:
                        r.text = ""
                else:
                    p.text = nt
                n += 1
    return n


def revoice_section_dividers(slide, idx: int) -> int:
    """Map lone Design section titles: Subject→SEE, Narrative→FEEL, Light→CRAFT."""
    # 0-based: slide 5 Subject, 16/18 Narrative, 27 Light intros already partly renamed
    alone_map = {
        4: "SEE",   # old Design (Subject block)
        17: "FEEL",  # Design leftover in Narrative block
    }
    want = alone_map.get(idx)
    n = 0
    for sh in iter_shapes(slide.shapes):
        if not sh.has_text_frame:
            continue
        for p in sh.text_frame.paragraphs:
            t = p.text
            nt = t
            if want and t.strip() == "Design":
                nt = want
            elif "critical visual building blocks to better image composition (design)" in t.lower():
                nt = t.replace("(design)", "(SEE · FEEL · CRAFT)")
            if nt != t:
                if p.runs:
                    p.runs[0].text = nt
                    for r in p.runs[1:]:
                        r.text = ""
                else:
                    p.text = nt
                n += 1
    return n


def revoice_intro_design(slide, idx: int) -> int:
    """Slides 3–4 old Design stage intro → model language."""
    if idx not in (2, 3):  # 0-based: slides 3 and 4
        return 0
    n = 0
    for sh in iter_shapes(slide.shapes):
        if not sh.has_text_frame:
            continue
        for p in sh.text_frame.paragraphs:
            t = p.text
            nt = t
            if t.strip() == "Design":
                nt = "SEE · FEEL · CRAFT"
            elif "design stage of creating a photograph" in t.lower():
                nt = (
                    "SEE · FEEL · CRAFT → STORY — "
                    "The camera serves the feeling. Craft comes last, in service of what you see and feel."
                )
            elif "See · Design · Shoot" in t or "See → Design · Shoot" in t:
                nt = t.replace("See · Design · Shoot", "SEE · FEEL · CRAFT → STORY").replace(
                    "See → Design → Shoot", "SEE · FEEL · CRAFT → STORY"
                )
            if nt != t:
                if p.runs:
                    p.runs[0].text = nt
                    for r in p.runs[1:]:
                        r.text = ""
                else:
                    p.text = nt
                n += 1
    return n


def main():
    assert SRC.exists(), SRC
    OUTBOX.mkdir(parents=True, exist_ok=True)
    print("copying...", SRC, "->", OUT)
    shutil.copy2(SRC, OUT)

    print("opening…")
    prs = Presentation(str(OUT))
    total = 0
    per = []
    for i, slide in enumerate(prs.slides):
        c = 0
        for sh in iter_shapes(slide.shapes):
            if sh.has_text_frame:
                c += replace_in_text_frame(sh.text_frame)
        c += revoice_intro_design(slide, i)
        c += revoice_section_dividers(slide, i)
        if i == 48:  # slide 49
            c += revoice_slide49(slide)
        if c:
            per.append((i + 1, c))
            total += c
    prs.save(str(OUT))
    print("saved", OUT, "bytes", OUT.stat().st_size)
    print("edits", total, "slides_touched", len(per))
    for s, c in per[:40]:
        print(f"  slide {s}: {c} edits")
    if len(per) > 40:
        print(f"  … +{len(per) - 40} more")


if __name__ == "__main__":
    main()
