"""Katvekuva ("EI SIGNAALIA") selostettuun lähetykseen.

Piirretään itse, koska testikuva on geometriaa eikä taidetta: näin kuva on
täysin oma eikä lisenssikysymystä synny. Sama PIL-ketju kuin thumbnaileissa.

Kaikki teksti on parametreja. Kuva on tarkoitettu renderöitäväksi uudelleen
katkon aikana (~0.2 s), jotta pistetilanne ja katkon kesto pysyvät tuoreina.
"""
from PIL import Image, ImageDraw, ImageFont
import glob

W, H = 1920, 1080
BARS_BOTTOM = 0.58          # väripalkkien osuus korkeudesta
PANEL = (14, 16, 15)

# Klassinen 7 palkin järjestys, 75 % kirkkaus.
BARS = [(192,192,192),(192,192,0),(0,192,192),(0,192,0),(192,0,192),(192,0,0),(0,0,192)]


def _font(size: int, bold: bool = True) -> ImageFont.FreeTypeFont:
    name = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
    hit = glob.glob(f"/usr/share/fonts/**/{name}", recursive=True)
    return ImageFont.truetype(hit[0], size) if hit else ImageFont.load_default()


def _centered(d: ImageDraw.ImageDraw, text: str, y: int, font, fill) -> None:
    box = d.textbbox((0, 0), text, font=font)
    d.text(((W - (box[2] - box[0])) / 2 - box[0], y), text, font=font, fill=fill)


def render(headline: str = "EI SIGNAALIA",
           score: str | None = None,
           status: str | None = None,
           footer: str = "Pesisselostaja") -> Image.Image:
    img = Image.new("RGB", (W, H), PANEL)
    d = ImageDraw.Draw(img)

    bars_h = H * BARS_BOTTOM
    bw = W / len(BARS)
    for i, c in enumerate(BARS):
        d.rectangle([i * bw, 0, (i + 1) * bw, bars_h], fill=c)
    # Kapea musta raita palkkien alla erottaa ne tekstipaneelista.
    d.rectangle([0, bars_h, W, bars_h + 8], fill=(0, 0, 0))

    _centered(d, headline, int(H * 0.63), _font(118), (255, 255, 255))
    if score:
        _centered(d, score, int(H * 0.775), _font(58), (255, 255, 255))
    if status:
        _centered(d, status, int(H * 0.855), _font(42, False), (165, 165, 165))
    _centered(d, footer, int(H * 0.945), _font(32, False), (105, 105, 105))
    return img


if __name__ == "__main__":
    render(
        score="Pesä Ysit 12 - 1 Espoon Pesis",
        status="1. jakso, 2 paloa — kuvayhteys katkesi 0:45 sitten, selostus jatkuu",
    ).save("run/no-signal-demo/A2-data.png")

    render(status="Kuvayhteyttä odotetaan — selostus jatkuu").save(
        "run/no-signal-demo/A3-ei-dataa.png")
    print("ok")
