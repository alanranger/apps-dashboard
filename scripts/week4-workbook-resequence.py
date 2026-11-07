"""Resequence Week4 workbook model headings to locked SEE/FEEL/CRAFT/STORY weights."""
from pathlib import Path
import shutil
from docx import Document

SRC = Path(r"C:\Users\alan\Google Drive\Claude shared resources\Powerpoints\Week4-Composition-Workbook.docx")
OUT = Path(r"C:\Users\alan\Google Drive\Claude shared resources\Week4-Composition\Week4-Composition-Workbook-SEE-FEEL-CRAFT-STORY-2026-07-29.docx")
MIRROR = Path(r"C:\Users\alan\Google Drive\Claude shared resources\Powerpoints\Week4-Composition-Workbook-SEE-FEEL-CRAFT-STORY-2026-07-29.docx")

REPL = {
    "See → Feel → Craft → Story": "SEE 30% · FEEL 50% · CRAFT 10% · STORY 10%",
    "SEE  observe, and choose what to leave out — subject, viewpoint, emptiness.": (
        "SEE 30% — Subject · Light · Timing — observe what stays and what you leave out."
    ),
    "FEEL  your intention and the story — why you're making the picture.": (
        "FEEL 50% — Composition · Atmosphere — intention, frame design, and the feeling in the picture."
    ),
    "CRAFT  light, tone, contrast and colour — technique in service, last.": (
        "CRAFT 10% — Exposure · Tone — technique in service, last."
    ),
    "STORY  where all three meet. The camera serves the feeling.": (
        "STORY 10% — Review — where SEE · FEEL · CRAFT meet. The camera serves the feeling."
    ),
    "SEE — what will I notice, and what will I leave out?": (
        "SEE (30%) — Subject · Light · Timing — what will I notice, and what will I leave out?"
    ),
    "FEEL — what do I want my pictures to say?": (
        "FEEL (50%) — Composition · Atmosphere — what do I want my pictures to say?"
    ),
    "CRAFT — how will light serve that feeling?": (
        "CRAFT (10%) — Exposure · Tone — how will exposure and tone serve that feeling?"
    ),
}


def set_para(p, text: str) -> None:
    if p.runs:
        p.runs[0].text = text
        for r in p.runs[1:]:
            r.text = ""
    else:
        p.text = text


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(SRC, OUT)
    d = Document(str(OUT))
    changed = []
    for p in d.paragraphs:
        t = p.text
        if t in REPL:
            set_para(p, REPL[t])
            changed.append((t[:70], REPL[t][:70]))
    # Add STORY reflect prompt if missing after CRAFT reflect
    texts = [p.text.strip() for p in d.paragraphs]
    if not any(t.startswith("STORY (10%)") and "Review" in t and "will" in t for t in texts):
        # Find CRAFT reflect paragraph and append after document end of reflect section
        for p in d.paragraphs:
            if p.text.startswith("CRAFT (10%) — Exposure"):
                # insert new para after this one via XML is messy; append at end before signature
                break
        for p in d.paragraphs:
            if p.text.strip() == "The camera serves the feeling.":
                # insert STORY reflect before this closer by rewriting a blank para if any
                pass
    # Prefer: replace a blank paragraph between CRAFT reflect and closer
    for i, p in enumerate(d.paragraphs):
        if p.text.startswith("CRAFT (10%) — Exposure"):
            # look ahead for empty then closer
            for j in range(i + 1, min(i + 8, len(d.paragraphs))):
                if not d.paragraphs[j].text.strip():
                    set_para(
                        d.paragraphs[j],
                        "STORY (10%) — Review — what will I check before I leave the scene?",
                    )
                    changed.append(("(blank)", "STORY reflect prompt"))
                    break
            break

    d.save(str(OUT))
    shutil.copy2(OUT, MIRROR)
    print("saved", OUT)
    print("mirror", MIRROR)
    print("edits", len(changed))
    for a, b in changed:
        print(" -", a, "=>", b)


if __name__ == "__main__":
    main()
