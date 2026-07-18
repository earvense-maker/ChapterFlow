from pathlib import Path
from typing import Iterable

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps


ROOT = Path(__file__).resolve().parents[1]
SCREENSHOTS = Path(r"C:\Users\Yuhei\Pictures\Screenshots")
CLIPBOARD_SHOT = Path(
    r"C:\Users\Yuhei\AppData\Local\Temp\codex-clipboard-ea4f7e41-33d8-4950-b0f5-e4a30c3a1e58.png"
)
GENERATED_BACKGROUND = Path(
    r"C:\Users\Yuhei\.codex\generated_images"
    r"\019f6b10-a55b-76b1-8e64-65fe11baf1ad"
    r"\call_ohLoo6vOrZSmcjSyIgx8CgFJ.png"
)
OUTPUT_DIR = ROOT / "docs" / "images"
OUTPUT_PATH = OUTPUT_DIR / "gemini-api-key-setup-guide.png"
BACKGROUND_COPY = OUTPUT_DIR / "gemini-api-key-guide-background.png"

WIDTH = 1800
HEIGHT = 4600
WHITE = (241, 244, 246, 255)
MUTED = (176, 190, 202, 255)
ACCENT = (121, 167, 190, 255)
ACCENT_BRIGHT = (143, 199, 226, 255)
CARD = (18, 23, 28, 232)
MASK_COLOR = (24, 24, 24, 255)

BOLD_FONT_PATH = r"C:\Windows\Fonts\YuGothB.ttc"
REGULAR_FONT_PATH = r"C:\Windows\Fonts\YuGothM.ttc"


def font(size: int, *, bold: bool = False) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(BOLD_FONT_PATH if bold else REGULAR_FONT_PATH, size)


def rounded_paste(
    base: Image.Image,
    image: Image.Image,
    xy: tuple[int, int],
    radius: int = 20,
) -> None:
    mask = Image.new("L", image.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, image.width - 1, image.height - 1), radius=radius, fill=255
    )
    base.paste(image, xy, image if image.mode == "RGBA" else mask)
    border = ImageDraw.Draw(base)
    border.rounded_rectangle(
        (xy[0], xy[1], xy[0] + image.width, xy[1] + image.height),
        radius=radius,
        outline=(113, 139, 153, 180),
        width=2,
    )


def redact(
    image: Image.Image,
    boxes: Iterable[tuple[int, int, int, int]],
    *,
    fill: tuple[int, int, int, int] = MASK_COLOR,
) -> Image.Image:
    result = image.convert("RGBA")
    draw = ImageDraw.Draw(result)
    for box in boxes:
        draw.rounded_rectangle(box, radius=8, fill=fill)
    return result


def scaled_screenshot(
    path: Path,
    width: int,
    *,
    crop: tuple[int, int, int, int] | None = None,
    redactions: Iterable[tuple[int, int, int, int]] = (),
) -> tuple[Image.Image, float, tuple[int, int]]:
    image = redact(Image.open(path), redactions)
    crop_origin = (0, 0)
    if crop:
        crop_origin = (crop[0], crop[1])
        image = image.crop(crop)
    scale = width / image.width
    resized = image.resize((width, round(image.height * scale)), Image.Resampling.LANCZOS)
    return resized, scale, crop_origin


def add_highlight(
    canvas: Image.Image,
    screenshot_xy: tuple[int, int],
    source_box: tuple[int, int, int, int],
    scale: float,
    crop_origin: tuple[int, int] = (0, 0),
) -> None:
    x1, y1, x2, y2 = source_box
    ox, oy = crop_origin
    box = (
        screenshot_xy[0] + round((x1 - ox) * scale),
        screenshot_xy[1] + round((y1 - oy) * scale),
        screenshot_xy[0] + round((x2 - ox) * scale),
        screenshot_xy[1] + round((y2 - oy) * scale),
    )
    glow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.rounded_rectangle(box, radius=16, outline=(120, 201, 239, 230), width=10)
    glow = glow.filter(ImageFilter.GaussianBlur(8))
    canvas.alpha_composite(glow)
    ImageDraw.Draw(canvas).rounded_rectangle(
        box, radius=16, outline=ACCENT_BRIGHT, width=5
    )


def draw_card(
    canvas: Image.Image,
    y: int,
    height: int,
    step: int,
    title: str,
    *,
    section_label: str | None = None,
) -> tuple[int, int]:
    left, right = 70, WIDTH - 70
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.rounded_rectangle(
        (left + 8, y + 12, right + 8, y + height + 12),
        radius=32,
        fill=(0, 0, 0, 145),
    )
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(14)))
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle(
        (left, y, right, y + height),
        radius=32,
        fill=CARD,
        outline=(93, 119, 133, 180),
        width=2,
    )
    draw.ellipse((105, y + 34, 173, y + 102), fill=ACCENT)
    number = str(step)
    number_box = draw.textbbox((0, 0), number, font=font(36, bold=True))
    draw.text(
        (
            139 - (number_box[2] - number_box[0]) / 2,
            y + 68 - (number_box[3] - number_box[1]) / 2 - 4,
        ),
        number,
        font=font(36, bold=True),
        fill=(12, 19, 23, 255),
    )
    draw.text((202, y + 36), title, font=font(38, bold=True), fill=WHITE)
    if section_label:
        label_width = draw.textlength(section_label, font=font(22, bold=True))
        label_x = WIDTH - 105 - label_width
        draw.rounded_rectangle(
            (label_x - 20, y + 40, WIDTH - 105, y + 84),
            radius=20,
            fill=(50, 72, 84, 220),
        )
        draw.text(
            (label_x - 7, y + 47),
            section_label,
            font=font(22, bold=True),
            fill=ACCENT_BRIGHT,
        )
    return left + 30, y + 125


def add_screenshot(
    canvas: Image.Image,
    image: Image.Image,
    *,
    y: int,
    x: int | None = None,
) -> tuple[int, int]:
    x = x if x is not None else (WIDTH - image.width) // 2
    rounded_paste(canvas, image, (x, y), radius=20)
    return x, y


def build() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    generated = Image.open(GENERATED_BACKGROUND).convert("RGB")
    generated.save(BACKGROUND_COPY, quality=95)
    background = ImageOps.fit(generated, (WIDTH, HEIGHT), method=Image.Resampling.LANCZOS)
    canvas = background.convert("RGBA")
    canvas.alpha_composite(Image.new("RGBA", canvas.size, (5, 8, 11, 90)))
    draw = ImageDraw.Draw(canvas)

    draw.text(
        (80, 58),
        "Gemini APIキーをChapterFlowに登録する",
        font=font(58, bold=True),
        fill=WHITE,
    )
    draw.text(
        (82, 143),
        "Google AI Studioでキーを作成し、ChapterFlowのアプリ設定へ保存します",
        font=font(29),
        fill=MUTED,
    )
    draw.rounded_rectangle((80, 205, 510, 217), radius=6, fill=ACCENT)

    # 1. Google AI Studio API Keys page.
    _, image_y = draw_card(
        canvas,
        255,
        585,
        1,
        "Google AI Studioの「APIキー」を開く",
        section_label="GOOGLE AI STUDIO",
    )
    shot1, scale1, crop1 = scaled_screenshot(
        SCREENSHOTS / "スクリーンショット 2026-07-17 145022.png",
        1600,
        crop=(0, 0, 1862, 490),
        redactions=[
            (365, 278, 455, 340),
            (655, 270, 895, 350),
            (1545, 135, 1780, 188),
        ],
    )
    shot1_xy = add_screenshot(canvas, shot1, y=image_y)
    add_highlight(canvas, shot1_xy, (1615, 50, 1810, 105), scale1, crop1)

    # 2. Key creation dialog.
    _, image_y = draw_card(canvas, 870, 750, 2, "「APIキーを作成」からプロジェクトを選ぶ")
    shot2_raw = Image.open(
        SCREENSHOTS / "スクリーンショット 2026-07-17 1453081.png"
    ).convert("RGBA")
    shot2_draw = ImageDraw.Draw(shot2_raw)
    shot2_draw.rounded_rectangle((45, 245, 608, 283), radius=10, fill=(35, 35, 35, 255))
    shot2_draw.text(
        (57, 250), "プロジェクトを選択", font=font(18), fill=(224, 228, 232, 255)
    )
    shot2_scale = 1000 / shot2_raw.width
    shot2 = shot2_raw.resize(
        (1000, round(shot2_raw.height * shot2_scale)), Image.Resampling.LANCZOS
    )
    shot2_xy = add_screenshot(canvas, shot2, y=image_y)
    add_highlight(canvas, shot2_xy, (495, 300, 632, 358), shot2_scale)

    # 3. Copy the key.
    _, image_y = draw_card(canvas, 1650, 550, 3, "コピーアイコンを押してAPIキーをコピー")
    shot3, scale3, crop3 = scaled_screenshot(
        SCREENSHOTS / "スクリーンショット 2026-07-17 14551114.png",
        1600,
        redactions=[
            (15, 235, 110, 303),
            (300, 225, 520, 320),
            (1190, 85, 1340, 140),
        ],
    )
    shot3_xy = add_screenshot(canvas, shot3, y=image_y)
    add_highlight(canvas, shot3_xy, (1250, 225, 1315, 302), scale3, crop3)

    draw.rounded_rectangle(
        (500, 2225, 1300, 2305),
        radius=38,
        fill=(43, 70, 84, 240),
        outline=(112, 162, 186, 190),
        width=2,
    )
    divider = "コピーしたキーを ChapterFlow へ"
    divider_width = draw.textlength(divider, font=font(30, bold=True))
    draw.text(
        ((WIDTH - divider_width) / 2, 2243),
        divider,
        font=font(30, bold=True),
        fill=WHITE,
    )

    # 4. Open ChapterFlow settings.
    _, image_y = draw_card(
        canvas,
        2330,
        430,
        4,
        "ChapterFlowの「アプリ設定」を開く",
        section_label="CHAPTERFLOW",
    )
    shot4, scale4, crop4 = scaled_screenshot(
        SCREENSHOTS / "スクリーンショット 2026-07-17 150643.png",
        1500,
    )
    shot4_xy = add_screenshot(canvas, shot4, y=image_y)
    add_highlight(canvas, shot4_xy, (820, 35, 965, 100), scale4, crop4)

    # 5. Paste the key and save.
    _, image_y = draw_card(
        canvas,
        2790,
        1220,
        5,
        "Geminiを選び、APIキーを貼り付けて保存",
    )
    shot5, scale5, crop5 = scaled_screenshot(CLIPBOARD_SHOT, 1350)
    shot5_xy = add_screenshot(canvas, shot5, y=image_y)
    add_highlight(canvas, shot5_xy, (25, 660, 970, 730), scale5, crop5)
    add_highlight(canvas, shot5_xy, (695, 728, 975, 795), scale5, crop5)

    # 6. Confirmation.
    _, image_y = draw_card(canvas, 4040, 420, 6, "保存完了メッセージが出たら準備完了")
    shot6, scale6, crop6 = scaled_screenshot(
        SCREENSHOTS / "スクリーンショット 2026-07-17 150544.png",
        1500,
        crop=(0, 0, 997, 180),
    )
    shot6_xy = add_screenshot(canvas, shot6, y=image_y)
    add_highlight(canvas, shot6_xy, (20, 88, 975, 165), scale6, crop6)

    draw.rounded_rectangle(
        (70, 4485, WIDTH - 70, 4570),
        radius=24,
        fill=(42, 30, 28, 230),
        outline=(174, 126, 110, 170),
        width=2,
    )
    draw.text(
        (105, 4501),
        "重要：APIキーはパスワードと同じ秘密情報です。共有・公開しないでください。",
        font=font(28, bold=True),
        fill=(242, 213, 200, 255),
    )
    draw.text(
        (105, 4542),
        "無料枠・利用上限は変更される場合があります。最新情報：ai.google.dev/pricing",
        font=font(20),
        fill=(208, 190, 181, 255),
    )

    canvas.convert("RGB").save(OUTPUT_PATH, format="PNG", optimize=True)
    print(OUTPUT_PATH)


if __name__ == "__main__":
    build()
