import assert from "node:assert/strict";
import test from "node:test";
import { clearKittyImages, deleteKittyImage, deleteKittyPlacement, encodeIterm2Graphic, encodeIterm2Png, encodeKittyPng, encodeSixel, placeKittyImage, selectImageProtocol } from "./image-protocols.js";

test("image protocol selection prefers native iTerm2 only in iTerm, otherwise Kitty, iTerm2, SIXEL, and ANSI", () => {
  assert.equal(selectImageProtocol({ kitty: true, iterm2: true, sixel: true }, "iTerm.app"), "iterm2");
  assert.equal(selectImageProtocol({ kitty: true, iterm2: true, sixel: true }), "kitty");
  assert.equal(selectImageProtocol({ kitty: true, iterm2: true, sixel: true }, "kitty"), "kitty");
  assert.equal(selectImageProtocol({ kitty: true, iterm2: true, sixel: true }, "ghostty"), "kitty");
  assert.equal(selectImageProtocol({ kitty: true, iterm2: false, sixel: true }, "iTerm.app"), "kitty");
  assert.equal(selectImageProtocol({ kitty: false, iterm2: true, sixel: true }), "iterm2");
  assert.equal(selectImageProtocol({ kitty: false, iterm2: false, sixel: true }), "sixel");
  assert.equal(selectImageProtocol({ kitty: false, iterm2: false, sixel: false }), "ansi");
});

test("Kitty PNG output uses bounded multipart APC chunks", () => {
  const output = encodeKittyPng(new Uint8Array([0, 1, 2, 3]), 4, 40, 12);
  assert.match(output, /^\x1b_Ga=T,f=100,q=2,c=40,r=12,m=1;/);
  assert.match(output, /\x1b_Gm=0;/);
  assert.match(output, /\x1b\\$/);
  assert.throws(() => encodeKittyPng(new Uint8Array([1]), 0), /positive safe integer/);
  assert.throws(() => encodeKittyPng(new Uint8Array([1]), -1), /positive safe integer/);
});

test("Kitty image cleanup uses a delete-all APC command", () => {
  assert.equal(clearKittyImages(), "\x1b_Ga=d,d=A,q=2\x1b\\");
});

test("Kitty image placements support stable per-image and per-placement IDs", () => {
  assert.match(encodeKittyPng(new Uint8Array([1]), 4096, 4, 2, 17, 23), /^\x1b_Ga=T,f=100,q=2,i=17,p=23,c=4,r=2,m=0;/);
  assert.equal(deleteKittyPlacement(23), "\x1b_Ga=d,d=p,p=23,q=2\x1b\\");
  assert.equal(deleteKittyImage(17), "\x1b_Ga=d,d=i,i=17,q=2\x1b\\");
  assert.equal(placeKittyImage(17, 23, 4, 2), "\x1b_Ga=p,i=17,p=23,c=4,r=2,C=1,q=2\x1b\\");
  assert.throws(() => encodeKittyPng(new Uint8Array([1]), 4096, 4, 2, 0), /i must be a positive safe integer/);
  assert.throws(() => deleteKittyPlacement(0), /p must be a positive safe integer/);
});

test("iTerm2 output uses inline OSC 1337 PNG transport with exact bytes and cell geometry", () => {
  const graphic = { data: new Uint8Array([1, 2, 3]), columns: 40, rows: 12 };
  const output = encodeIterm2Graphic(graphic);
  assert.equal(output, "\x1b]1337;File=inline=1;size=3;preserveAspectRatio=0;doNotMoveCursor=1;width=40;height=12;:AQID\x07");
  assert.deepEqual(Buffer.from(/:([A-Za-z0-9+/=]*)\x07$/.exec(output)?.[1] ?? "", "base64"), Buffer.from(graphic.data));
  assert.equal(encodeIterm2Png(new Uint8Array(), 0, Number.NaN), "\x1b]1337;File=inline=1;size=0;preserveAspectRatio=0;doNotMoveCursor=1;width=1;height=1;:\x07");
});

test("SIXEL output is a DCS stream with palette and six-bit data", () => {
  const output = encodeSixel({ width: 2, height: 2, data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]) }, 2);
  assert.match(output, /^\x1bPq#0;2;/);
  assert.match(output, /[?-~]/);
  assert.match(output, /\x1b\\$/);
});
