from pathlib import Path
from typing import Iterable

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps


ROOT = Path(__file__).resolve().parents[1]
TEMP = Path(r"C:\Users\Yuhei\AppData\Local\Temp")
GENERATED_BACKGROUND = Path(
    r"C:\Users\Yuhei\.codex\generated_images"
    r"\019f6b10-a55b-76b1-8e64-65fe11baf1ad"
    r"\call_K2r3HX0mD8q6WagYOsnhOb8l.png"
)
OUTPUT_DIR = ROOT / "docs" / "images"
OUTPUT_PATH = OUTPUT_DIR / "deepseek-paypal-api-key-setup-guide.png"
BACKGROUND_COPY = OUTPUT_DIR / "deepseek-api-key-guide-background.png"

LOGIN = TEMP / "codex-clipboard-b8daa56b-b164-44b9-bf85-02c85ff994b3.png"
TOP_UP = TEMP / "codex-clipboard-446a3561-afb8-4a6c-aae2-744fb61447c8.png"
PAYPAL = TEMP / "codex-clipboard-239becf3-8dec-4b6c-be08-9c0abaa6313e.png"
API_KEYS = TEMP / "codex-clipboard-a28a4824-c639-412e-a812-967d50b5651f.png"
CREATE_KEY = TEMP / "codex-clipboard-92ba340c-5cb6-40d5-80f6-38cb26cb22fc.png"
COPY_KEY = TEMP / "codex-clipboard-5c47bb51-d683-4b7c-a72c-d2a00b6a7797.png"
CHAPTERFLOW = TEMP / "codex-clipboard-50d37875-2f64-4051-a58a-c44c76d42ee2.png"

WIDTH = 1800
HEIGHT = 6220
WHITE = (246, 239, 233, 255)
MUTED = (204, 184, 190, 255)
GOLD = (205, 168, 106, 255)
GOLD_BRIGHT = (236, 201, 135, 255)
BURGUNDY = (111, 43, 69, 255)
CARD = (22, 13, 20, 238)
MASK_COLOR = (23, 20, 23, 255)

BOLD_FONT_PATH = r"C:\Windows\Fonts\YuGothB.ttc"
REGULAR_FONT_PATH = r"C:\Windows\Fonts\YuGothM.ttc"


def font(size: int, *, bold: bool = False) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(BOLD_FONT_PATH if bold else REGULAR_FONT_PATH, size)


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
    image = image.resize(
        (width, round(image.height * scale)), Image.Resampling.LANCZOS
    )
    return image, scale, crop_origin


def rounded_paste(
    base: Image.Image,
    image: Image.Image,
    xy: tuple[int, int],
    radius: int = 22,
) -> None:
    mask = Image.new("L", image.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, image.width - 1, image.height - 1), radius=radius, fill=255
    )
    base.paste(image, xy, mask)
    ImageDraw.Draw(base).rounded_rectangle(
        (xy[0], xy[1], xy[0] + image.width, xy[1] + image.height),
        radius=radius,
        outline=(175, 133, 94, 200),
        width=2,
    )


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
    glow_draw.rounded_rectangle(box, radius=17, outline=(235, 184, 109, 230), width=12)
    canvas.alpha_composite(glow.filter(ImageFilter.GaussianBlur(10)))
    ImageDraw.Draw(canvas).rounded_rectangle(
        box, radius=17, outline=GOLD_BRIGHT, width=5
    )


def draw_card(
    canvas: Image.Image,
    y: int,
    height: int,
    step: int,
    title: str,
    *,
    section_label: str | None = None,
    note: str | None = None,
) -> tuple[int, int]:
    left, right = 64, WIDTH - 64
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.rounded_rectangle(
        (left + 10, y + 16, right + 10, y + height + 16),
        radius=34,
        fill=(0, 0, 0, 160),
    )
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(16)))
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle(
        (left, y, right, y + height),
        radius=34,
        fill=CARD,
        outline=(170, 124, 84, 210),
        width=2,
    )
    draw.ellipse(
        (100, y + 33, 172, y + 105),
        fill=BURGUNDY,
        outline=GOLD,
        width=3,
    )
    number = str(step)
    number_box = draw.textbbox((0, 0), number, font=font(36, bold=True))
    draw.text(
        (
            136 - (number_box[2] - number_box[0]) / 2,
            y + 69 - (number_box[3] - number_box[1]) / 2 - 4,
        ),
        number,
        font=font(36, bold=True),
        fill=WHITE,
    )
    draw.text((202, y + 34), title, font=font(37, bold=True), fill=WHITE)
    if note:
        draw.text((204, y + 84), note, font=font(22), fill=MUTED)
    if section_label:
        label_width = draw.textlength(section_label, font=font(21, bold=True))
        label_x = WIDTH - 104 - label_width
        draw.rounded_rectangle(
            (label_x - 20, y + 42, WIDTH - 104, y + 84),
            radius=19,
            fill=(78, 34, 51, 235),
            outline=(178, 125, 85, 180),
            width=1,
        )
        draw.text(
            (label_x - 7, y + 48),
            section_label,
            font=font(21, bold=True),
            fill=GOLD_BRIGHT,
        )
    return left + 30, y + (145 if note else 125)


def add_screenshot(
    canvas: Image.Image,
    image: Image.Image,
    *,
    y: int,
    x: int | None = None,
) -> tuple[int, int]:
    x = x if x is not None else (WIDTH - image.width) // 2
    rounded_paste(canvas, image, (x, y))
    return x, y


def build() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    generated = Image.open(GENERATED_BACKGROUND).convert("RGB")
    generated.save(BACKGROUND_COPY, quality=95)

    canvas = ImageOps.fit(
        generated,
        (WIDTH, HEIGHT),
        method=Image.Resampling.LANCZOS,
    ).convert("RGBA")
    canvas.alpha_composite(Image.new("RGBA", canvas.size, (5, 2, 6, 88)))
    draw = ImageDraw.Draw(canvas)

    draw.rounded_rectangle(
        (80, 40, 385, 91),
        radius=22,
        fill=(90, 35, 55, 240),
        outline=(195, 151, 91, 190),
        width=2,
    )
    draw.text(
        (107, 51),
        "MATURE CREATIVE",
        font=font(22, bold=True),
        fill=GOLD_BRIGHT,
    )
    draw.text(
        (80, 115),
        "表現の制限が緩いDeepSeekで、創作の幅を広げる",
        font=font(51, bold=True),
        fill=WHITE,
    )
    draw.text(
        (82, 193),
        "PayPalで少額チャージし、APIキーをChapterFlowへ登録します",
        font=font(29),
        fill=MUTED,
    )
    draw.rounded_rectangle((82, 246, 545, 258), radius=6, fill=GOLD)

    # 1. Login, including Google login.
    _, image_y = draw_card(
        canvas,
        285,
        800,
        1,
        "DeepSeek Platformへログイン",
        section_label="DEEPSEEK PLATFORM",
        note="メールアドレスのほか、Googleアカウントでもログインできます",
    )
    shot1, scale1, crop1 = scaled_screenshot(LOGIN, 620)
    shot1_xy = add_screenshot(canvas, shot1, y=image_y)
    add_highlight(canvas, shot1_xy, (205, 512, 375, 563), scale1, crop1)

    # 2. Top up and select PayPal.
    _, image_y = draw_card(
        canvas,
        1115,
        1040,
        2,
        "「Top up」で少額を選び、PayPalを指定",
        note="表示される税・合計額・支払方法は地域や時期によって変わります",
    )
    shot2, scale2, crop2 = scaled_screenshot(
        TOP_UP,
        1450,
        crop=(0, 0, 1326, 748),
    )
    shot2_xy = add_screenshot(canvas, shot2, y=image_y)
    add_highlight(canvas, shot2_xy, (515, 75, 1175, 205), scale2, crop2)
    add_highlight(canvas, shot2_xy, (515, 475, 1275, 545), scale2, crop2)

    # 3. PayPal checkout.
    _, image_y = draw_card(canvas, 2185, 680, 3, "PayPalを選び、支払いを完了")
    shot3, scale3, crop3 = scaled_screenshot(PAYPAL, 1200)
    shot3_xy = add_screenshot(canvas, shot3, y=image_y)
    add_highlight(canvas, shot3_xy, (45, 245, 805, 335), scale3, crop3)

    # 4. API key page.
    _, image_y = draw_card(canvas, 2895, 500, 4, "「API keys」から新しいキーを作成")
    shot4, scale4, crop4 = scaled_screenshot(
        API_KEYS,
        1550,
        crop=(0, 0, 1746, 250),
    )
    shot4_xy = add_screenshot(canvas, shot4, y=image_y)
    add_highlight(canvas, shot4_xy, (1480, 165, 1705, 220), scale4, crop4)

    # 5. Name and create the key.
    _, image_y = draw_card(canvas, 3425, 650, 5, "わかりやすい名前を付けて作成")
    shot5, scale5, crop5 = scaled_screenshot(CREATE_KEY, 850)
    shot5_xy = add_screenshot(canvas, shot5, y=image_y)
    add_highlight(canvas, shot5_xy, (305, 210, 482, 270), scale5, crop5)

    # 6. Copy the one-time key.
    _, image_y = draw_card(
        canvas,
        4105,
        760,
        6,
        "表示されたAPIキーをコピー",
        note="キーは再表示できないため、安全な場所へ控えてから閉じます",
    )
    shot6_raw = Image.open(COPY_KEY).convert("RGBA")
    shot6_draw = ImageDraw.Draw(shot6_raw)
    shot6_draw.rounded_rectangle(
        (72, 245, 500, 307), radius=14, fill=(31, 25, 30, 255)
    )
    hidden_label = "APIキー（非表示）"
    hidden_width = shot6_draw.textlength(hidden_label, font=font(18, bold=True))
    shot6_draw.text(
        ((572 - hidden_width) / 2, 259),
        hidden_label,
        font=font(18, bold=True),
        fill=(224, 208, 213, 255),
    )
    scale6 = 820 / shot6_raw.width
    shot6 = shot6_raw.resize(
        (820, round(shot6_raw.height * scale6)), Image.Resampling.LANCZOS
    )
    shot6_xy = add_screenshot(canvas, shot6, y=image_y)
    add_highlight(canvas, shot6_xy, (392, 318, 505, 378), scale6)

    draw.rounded_rectangle(
        (455, 4885, 1345, 4965),
        radius=38,
        fill=(80, 34, 51, 242),
        outline=(195, 151, 91, 210),
        width=2,
    )
    divider = "コピーしたキーを ChapterFlow へ"
    divider_width = draw.textlength(divider, font=font(30, bold=True))
    draw.text(
        ((WIDTH - divider_width) / 2, 4903),
        divider,
        font=font(30, bold=True),
        fill=WHITE,
    )

    # 7. ChapterFlow settings.
    _, image_y = draw_card(
        canvas,
        4995,
        1110,
        7,
        "DeepSeekを選び、APIキーを貼り付けて保存",
        section_label="CHAPTERFLOW",
        note="モデルは deepseek-v4-pro。入力後「APIキーを保存して相談で使う」を押します",
    )
    shot7, scale7, crop7 = scaled_screenshot(CHAPTERFLOW, 1200)
    shot7_xy = add_screenshot(canvas, shot7, y=image_y)
    add_highlight(canvas, shot7_xy, (35, 655, 985, 722), scale7, crop7)
    add_highlight(canvas, shot7_xy, (710, 722, 995, 790), scale7, crop7)

    draw.rounded_rectangle(
        (64, 6120, WIDTH - 64, 6200),
        radius=24,
        fill=(50, 23, 32, 244),
        outline=(195, 151, 91, 190),
        width=2,
    )
    draw.text(
        (96, 6135),
        "DeepSeekは表現の制限が比較的緩めですが、利用規約や安全対策による制限はあります。",
        font=font(25, bold=True),
        fill=(241, 218, 205, 255),
    )
    draw.text(
        (96, 6170),
        "APIキーは秘密情報です。チャージは前払い。最新情報：api-docs.deepseek.com/faq",
        font=font(19),
        fill=(213, 188, 180, 255),
    )

    canvas.convert("RGB").save(OUTPUT_PATH, format="PNG", optimize=True)
    print(OUTPUT_PATH)


if __name__ == "__main__":
    build()
