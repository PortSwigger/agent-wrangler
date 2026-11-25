---
name: show-image
description: Use when the human would understand something faster by seeing it — a screenshot of a page or app you changed, a chart or plot, a diagram, rendered output — and you want it inline in your Agent Wrangler chat. Covers the show_image tool, which files it takes, and when not to use it.
---

# Show an image

`show_image` puts an image inline in your session's Chat view on the Agent
Wrangler board, as a thumbnail the human can click to see full size. Use it
when a picture says it better than a description:

- a **screenshot** of the page, app or terminal you just changed or tested;
- a **chart or plot** of results you computed;
- a **diagram** you drew (architecture, flow, sequence);
- **rendered output**: a generated image, a rendered document page, a visual diff.

## How

1. Save the image to a file: a PNG, JPEG, GIF or WebP, up to 5 MB.
   - A browser screenshot: Playwright's `page.screenshot({ path: '/abs/shot.png' })`,
     or your browser tool's own screenshot saved to a file.
   - A chart: `plt.savefig('/abs/chart.png')`, or your plotting library's PNG export.
   - A diagram or document: render it to PNG first (SVG and PDF are not shown).
2. Call `show_image` with the file's **absolute** path:

   ```json
   { "path": "/work/app/shots/home.png" }
   ```

3. Say in your reply what the image shows and what to look at. The human may
   read the image without the tool row around it.

The tool answers with the image and one line (`Shown in Chat: home.png (PNG, 214 KB).`).
You see the image too, so you can check it shows what you meant.

## What is refused

Each refusal says why, so fix the call rather than retrying it as is:

- a **relative** path (the error names the absolute path it would be);
- a **missing** file, or a directory;
- anything that is not PNG, JPEG, GIF or WebP, by extension or by its contents;
- a file over **5 MB**: save a downscaled copy, or a JPEG for a photo.

A session in a container or at a remote location cannot use it: the board
reads the file on its own machine, where those paths do not exist.

## When not to

- Not for text: a log, a diff or a table reads better as text in your reply.
- Not for anything you would not paste into the chat: a screenshot can carry
  secrets, tokens or personal data. Crop or redact it first.
- Each image stays in your conversation and costs context every turn after.
  Show the one that matters, not every intermediate step.
