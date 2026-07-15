import io
import os
import re
from collections import defaultdict

import pytesseract
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from PIL import Image, UnidentifiedImageError
from pytesseract import Output

app = FastAPI(title="AgentCore Tesseract OCR", version="1.0.0")

MAX_IMAGE_BYTES = int(os.getenv("OCR_MAX_IMAGE_BYTES", str(15 * 1024 * 1024)))
MAX_IMAGE_PIXELS = int(os.getenv("OCR_MAX_IMAGE_PIXELS", "40000000"))
OCR_TIMEOUT_SECONDS = int(os.getenv("OCR_TIMEOUT_SECONDS", "45"))
OCR_LANGUAGES = os.getenv("OCR_LANGUAGES", "eng")
OCR_API_KEY = os.getenv("OCR_API_KEY", "")

if not re.fullmatch(r"[A-Za-z0-9_.+-]+", OCR_LANGUAGES):
    raise RuntimeError("OCR_LANGUAGES contains unsupported characters")

Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS


@app.get("/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "provider": "local-tesseract",
        "version": str(pytesseract.get_tesseract_version()),
    }


@app.post("/v1/ocr")
async def recognize_page(
    file: UploadFile = File(...),
    pageNumber: int = Form(...),
    documentName: str | None = Form(default=None),
    authorization: str | None = Header(default=None),
) -> dict[str, object]:
    _authorize(authorization)
    if file.content_type != "image/png":
        raise HTTPException(status_code=415, detail="Only image/png is supported")

    payload = await file.read(MAX_IMAGE_BYTES + 1)
    if len(payload) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Rendered page is too large")

    try:
        with Image.open(io.BytesIO(payload)) as image:
            if image.width * image.height > MAX_IMAGE_PIXELS:
                raise HTTPException(status_code=413, detail="Rendered page has too many pixels")
            image_width = image.width
            image_height = image.height
            image.load()
            data = pytesseract.image_to_data(
                image.convert("RGB"),
                lang=OCR_LANGUAGES,
                config="--oem 1 --psm 3",
                output_type=Output.DICT,
                timeout=OCR_TIMEOUT_SECONDS,
            )
    except (Image.DecompressionBombError, UnidentifiedImageError, OSError) as error:
        raise HTTPException(status_code=422, detail="Invalid PNG image") from error
    except RuntimeError as error:
        raise HTTPException(status_code=504, detail="OCR processing timed out") from error

    text, confidence, word_count = _reconstruct_text(data)
    return {
        "text": text,
        "confidence": confidence,
        "provider": "local-tesseract",
        "model": f"tesseract-{pytesseract.get_tesseract_version()}",
        "metadata": {
            "pageNumber": pageNumber,
            "documentName": documentName,
            "languages": OCR_LANGUAGES,
            "wordCount": word_count,
            "width": image_width,
            "height": image_height,
        },
    }


def _authorize(authorization: str | None) -> None:
    if not OCR_API_KEY:
        return
    if authorization != f"Bearer {OCR_API_KEY}":
        raise HTTPException(status_code=401, detail="Invalid OCR API key")


def _reconstruct_text(data: dict[str, list[object]]) -> tuple[str, float | None, int]:
    lines: dict[tuple[int, int, int, int], list[str]] = defaultdict(list)
    confidences: list[float] = []
    word_count = 0

    for index, raw_text in enumerate(data.get("text", [])):
        text = str(raw_text).strip()
        if not text:
            continue
        raw_confidence = data.get("conf", [])[index]
        try:
            confidence = float(raw_confidence)
        except (TypeError, ValueError):
            confidence = -1
        if confidence >= 0:
            confidences.append(confidence)
        key = (
            int(data["page_num"][index]),
            int(data["block_num"][index]),
            int(data["par_num"][index]),
            int(data["line_num"][index]),
        )
        lines[key].append(text)
        word_count += 1

    text = "\n".join(" ".join(words) for words in lines.values()).strip()
    confidence = (
        round(sum(confidences) / len(confidences) / 100, 4)
        if confidences
        else None
    )
    return text, confidence, word_count
