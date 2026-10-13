# Book Scanner

Scan a book page by page and save it as a Word document (.docx). The scanner is built into
the app: use your Mac's camera, an iPhone (Continuity Camera), a USB document camera or a
flatbed scanner. You can also import photos or scans you already have.

Scanning starts with **page one**. The app reads the page number printed on each page and
uses it in the Word document, so every page in Word has the same number as in the book.

## Install (Mac)

1. Install **Python** from [python.org/downloads](https://www.python.org/downloads/) if you
   don't already have it (the IP Scanner instructions in the main README use the same Python).
2. Open **Terminal** and run:

   ```bash
   cd ~/IP-Scanner && git pull && book_scanner/build_app.sh
   ```

   This builds **Book Scanner.app** in Applications and opens it. It downloads the app's
   Python packages the first time, so it takes a minute or two.
3. The first time you press **Start**, macOS asks whether Book Scanner may use the camera.
   Click **Allow**. (If you clicked Don't Allow, turn it on in **System Settings → Privacy &
   Security → Camera**.)

Text recognition uses Apple's built-in Vision engine, so there is nothing else to install.

To run it without building the app: `pip3 install -r book_scanner/requirements.txt`, then
`python3 book_scanner/book_scanner_gui.py`. On Windows or Linux, also install
[Tesseract](https://tesseract-ocr.github.io/tessdoc/Installation.html) for text recognition.

## Scanning a book

1. **File → New Book…** and type the title. Each book is kept in its own folder in
   *Documents → Book Scanner*, so you can close the app and carry on later.
2. Choose the scanner at the top left and press **Start**.
   - *Camera*: hold the camera (or the iPhone) above the book, looking straight down, with
     good, even light. A green outline shows the page the app has found.
   - *Flatbed scanner*: appears when SANE's `scanimage` is installed
     (`brew install sane-backends`). Each **Capture Page** scans one page.
3. Open the book at **page one** and press **Space** (or **Capture Page**). Turn the page and
   press Space again, and so on.
   - **Auto-capture** takes the picture for you: turn the page, take your hand away, and the
     page is captured once the picture has been still for about a second.
   - **Two pages per shot** photographs both facing pages and splits them at the fold.
   - **Find page edges** crops to the page and straightens it.
4. Each page appears in the list on the left while its text is read in the background.
5. **Export .docx…** and choose the paper size. Done.

## Page numbers

The **Book page** column shows the number each page will have in Word, and **Number** shows
where it came from:

| Number | Meaning |
|---|---|
| found on page | The number printed on the page (in the header or footer) was read. It is outlined in green on the page picture and left out of the text. |
| counted | No number is printed (chapter openings, blank pages, pictures), so the app counted on from the page before. |
| set by hand | You typed the number in. |

- If you skip pages while scanning, the printed number on the next page (up to 10 pages
  ahead) is picked up and the numbering jumps ahead with it.
- If the first page you scan isn't page one, change **First scanned page is page**.
- To fix a number, double-click the page (or select it and click **#**). The pages after it
  follow on from the new number.

In the Word document every book page starts on a new page, and the footer shows the book's
page number. If a lot of text doesn't fit on one Word page, choose a bigger paper size.

## Correcting pages

- **Page text** on the right can be edited; your changes are kept and used in the document.
  Leave a blank line between paragraphs.
- **▲ / ▼** move a page, **⟳** rotates it 90° (the text is read again), **Delete** removes it.
- **Page → Read Text Again** re-reads the selected pages (and drops your edits).
- **File → Import Images…** adds photos or scans (JPEG, PNG, TIFF, HEIC) to the end of the book,
  sorted by file name.

## Files

| File | What it does |
|---|---|
| `book_scanner_gui.py` | The app window |
| `capture.py` | Camera, flatbed scanner, page detection, straightening, splitting spreads, auto-capture |
| `ocr.py` | Text recognition (Apple Vision on a Mac, Tesseract elsewhere) |
| `book.py` | Pages, page-number detection and counting, paragraphs, saving and loading a book |
| `export_docx.py` | Writes the Word document |
| `build_app.sh` | Builds Book Scanner.app |

Run the tests with `cd book_scanner && python3 -m unittest discover -s tests -v`.
