"""Dump mockup Week4 slide text for mapping."""
from pptx import Presentation
import os

mock = os.path.expanduser(r"~\Downloads\Week4-Composition-The-Art-and-Science-of-Seeing.pptx")
out = os.path.expanduser(r"~\Downloads\week4-mockup-dump.txt")
prs = Presentation(mock)
lines = [f"slides {len(prs.slides)} w {prs.slide_width} h {prs.slide_height}"]
for i, slide in enumerate(prs.slides, 1):
    texts = []
    for sh in slide.shapes:
        if not sh.has_text_frame:
            continue
        t = "\n".join(p.text.strip() for p in sh.text_frame.paragraphs if p.text.strip())
        if t:
            texts.append(t[:300])
    title = texts[0] if texts else "(no text)"
    lines.append(f"\n=== MOCK {i}: {title[:100]} ===")
    for t in texts[:12]:
        lines.append(" - " + t.replace("\n", " | ")[:220])
text = "\n".join(lines)
open(out, "w", encoding="utf-8").write(text)
print("wrote", out, "chars", len(text))
