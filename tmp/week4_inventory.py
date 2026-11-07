"""Read-only Week 4 composition deck inventory → markdown."""
from pptx import Presentation
from pptx.util import Emu, Inches, Pt
from pptx.enum.shapes import MSO_SHAPE_TYPE
import os

DECK = r"G:\Dropbox\alan ranger photography\Modules\Beginners Course\week 4 composition.pptm"
OUT = r"C:\Users\alan\Google Drive\Claude shared resources\Cursor Outputs for Claude\RESPONSE-2026-07-27-week4-slide-inventory-LATEST.md"

def shape_kind(shape):
    try:
        t = shape.shape_type
    except Exception:
        return "unknown"
    if t == MSO_SHAPE_TYPE.PICTURE:
        return "picture"
    if t == MSO_SHAPE_TYPE.PLACEHOLDER:
        return "placeholder"
    if t == MSO_SHAPE_TYPE.TEXT_BOX:
        return "textbox"
    if t == MSO_SHAPE_TYPE.AUTO_SHAPE:
        return "autoshape"
    if t == MSO_SHAPE_TYPE.GROUP:
        return "group"
    if t == MSO_SHAPE_TYPE.TABLE:
        return "table"
    if t == MSO_SHAPE_TYPE.CHART:
        return "chart"
    return str(t)

def text_of(shape):
    if not getattr(shape, "has_text_frame", False):
        return ""
    parts = []
    for p in shape.text_frame.paragraphs:
        t = "".join(run.text for run in p.runs).strip()
        if not t and p.text:
            t = p.text.strip()
        if t:
            parts.append(t)
    return " | ".join(parts)

def pos_label(shape, slide_w, slide_h):
    try:
        l, t, w, h = shape.left, shape.top, shape.width, shape.height
    except Exception:
        return "?"
    cx = (l + w / 2) / slide_w
    cy = (t + h / 2) / slide_h
    area = (w * h) / (slide_w * slide_h)
    if area > 0.55:
        return "full-bleed"
    horiz = "left" if cx < 0.38 else ("right" if cx > 0.62 else "centre")
    vert = "top" if cy < 0.35 else ("bottom" if cy > 0.65 else "mid")
    return f"{horiz}/{vert}"

def pic_desc(shape, idx):
    # No vision — describe by size/position + filename if available
    name = ""
    try:
        name = shape.name or ""
    except Exception:
        pass
    try:
        blob_name = ""
        if hasattr(shape, "image") and shape.image:
            blob_name = getattr(shape.image, "filename", "") or ""
    except Exception:
        blob_name = ""
    label = blob_name or name or f"photo{idx}"
    # strip noise
    label = str(label).replace("_", " ")[:40]
    return label

def fonts_on_slide(slide):
    fonts = set()
    sizes = set()
    for shape in slide.shapes:
        if not getattr(shape, "has_text_frame", False):
            continue
        for p in shape.text_frame.paragraphs:
            for run in p.runs:
                try:
                    if run.font.name:
                        fonts.add(run.font.name)
                    if run.font.size:
                        sizes.add(int(run.font.size.pt))
                except Exception:
                    pass
    return fonts, sizes

def main():
    prs = Presentation(DECK)
    sw, sh = prs.slide_width, prs.slide_height
    ratio = sw / sh
    orient = "16:9" if abs(ratio - 16/9) < 0.05 else ("4:3" if abs(ratio - 4/3) < 0.05 else f"custom {ratio:.3f}")
    px_w = int(sw / 914400 * 96)  # EMU to approx CSS px at 96dpi
    px_h = int(sh / 914400 * 96)

    all_fonts = set()
    layouts = {}
    rows = []

    for i, slide in enumerate(prs.slides, 1):
        layout = slide.slide_layout.name if slide.slide_layout else "?"
        layouts[layout] = layouts.get(layout, 0) + 1
        fonts, sizes = fonts_on_slide(slide)
        all_fonts |= fonts

        title = ""
        body_bits = []
        images = []
        diagrams = []
        branding = []
        pic_i = 0

        for shape in slide.shapes:
            kind = shape_kind(shape)
            txt = text_of(shape)
            low = txt.lower()

            if kind == "picture" or (kind == "placeholder" and getattr(shape, "image", None)):
                pic_i += 1
                try:
                    has_img = True
                    _ = shape.image
                except Exception:
                    has_img = kind == "picture"
                if has_img or kind == "picture":
                    images.append(f"{pic_desc(shape, pic_i)} ({pos_label(shape, sw, sh)})")
                continue

            if kind == "group":
                diagrams.append(f"grouped graphic ({pos_label(shape, sw, sh)})")
                continue

            if kind in ("autoshape", "chart", "table"):
                if txt:
                    diagrams.append(f"{kind}: {txt[:40]} ({pos_label(shape, sw, sh)})")
                else:
                    diagrams.append(f"{kind} ({pos_label(shape, sw, sh)})")

            if not txt:
                continue

            if "alanranger" in low or "alan ranger" in low or "logo" in (shape.name or "").lower():
                branding.append(f"'{txt[:50]}' ({pos_label(shape, sw, sh)})")
            elif any(x in low for x in ("www.", ".com", "photography")) and len(txt) < 80:
                branding.append(f"'{txt[:50]}' ({pos_label(shape, sw, sh)})")

            # title heuristic: first substantial text near top
            try:
                near_top = shape.top < sh * 0.28
            except Exception:
                near_top = False
            if not title and near_top and len(txt) < 120:
                title = txt.split(" | ")[0][:100]
            elif txt:
                # body: first line / bullets only
                first = txt.split(" | ")[0][:80]
                if first and first != title and first not in body_bits:
                    body_bits.append(first)
                    if len(body_bits) >= 4:
                        pass

        if not title:
            # fallback first text
            for shape in slide.shapes:
                txt = text_of(shape)
                if txt:
                    title = txt.split(" | ")[0][:100]
                    break
            if not title:
                title = "(untitled)"

        rows.append({
            "n": i,
            "title": title.replace("|", "/"),
            "body": "; ".join(body_bits[:4]).replace("|", "/") or "—",
            "images": "; ".join(images) if images else "none",
            "brand": "; ".join(branding) if branding else "none visible in text",
            "diagrams": "; ".join(diagrams[:5]) if diagrams else "none",
            "layout": layout,
        })

    lines = []
    lines.append("---")
    lines.append("answers_question: 2026-07-27-week4-slide-inventory")
    lines.append("question_file: QUESTION-2026-07-27-week4-slide-inventory.md")
    lines.append("answered_by: cursor")
    lines.append("answered_at: 2026-07-27T18:35:00Z")
    lines.append("status: complete")
    lines.append("---")
    lines.append("")
    lines.append("# RESPONSE — Week 4 composition deck slide inventory (READ-ONLY)")
    lines.append("")
    lines.append(f"**Source used:** `{DECK}`")
    lines.append(f"(Extracted Week 4 deck with images. Full course `5 week beginnerscamera course v7 2026.pptm` is ~1.2GB; this file is the Week 4 section.)")
    lines.append("")
    lines.append("## Section-level")
    lines.append(f"- **Slides:** {len(rows)}")
    lines.append(f"- **Dimensions:** {orient} — {sw}×{sh} EMU (~{px_w}×{px_h} px at 96dpi)")
    lines.append(f"- **Fonts seen in runs:** {', '.join(sorted(all_fonts)) or '(theme defaults / not embedded in runs)'}")
    lines.append("- **Brand colours:** not reliably extractable as hex from pptx theme without deeper XML parse; slides use AR photography branding (logo/footer where noted per slide).")
    lines.append("- **Layouts / masters used (counts):**")
    for name, c in sorted(layouts.items(), key=lambda x: -x[1]):
        lines.append(f"  - `{name}` × {c}")
    lines.append("")
    lines.append("## Per-slide inventory")
    lines.append("")
    lines.append("| # | Title | Body (brief) | Images | Branding | Diagrams / graphics | Layout |")
    lines.append("|--:|-------|--------------|--------|----------|---------------------|--------|")
    for r in rows:
        lines.append(
            f"| {r['n']} | {r['title']} | {r['body']} | {r['images']} | {r['brand']} | {r['diagrams']} | {r['layout']} |"
        )
    lines.append("")
    lines.append("## Notes for Claude")
    lines.append("- Image descriptions are **filename/shape-name based** (no vision model). Open the deck for photo content judgement.")
    lines.append("- Logo detection is text/name heuristic; some logo pictures may appear only under Images.")
    lines.append("- No files were modified.")
    lines.append("")

    with open(OUT, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print("Wrote", OUT, "slides", len(rows))

if __name__ == "__main__":
    main()
