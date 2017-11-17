/* Copyright (C) 2016-2017 Chase
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */


 /* global browser */

; // eslint-disable-line no-extra-semi
(function() {
"use strict";

const FRAME_UUID = genUUIDv4();
const TOP_FRAME_UUID = "top";

var tabId = null;
var frameId = null;
const port = browser.runtime.connect({
  "name": FRAME_UUID
});

const MessageCommands = Object.freeze({
  "CAPTURE_START": "capture-start",
  "CAPTURE_STOP": "capture-stop",
  "DISABLE": "disable",
  "DISCONNECT": "disconnect",
  "DISPLAY": "display",
  "DOWNLOAD": "download",
  "HIGHLIGHT": "highlight",
  "NOTIFY": "notify",
  "REGISTER": "register",
  "UPDATE_CANVASES": "update-canvases"
});

const MIME_TYPE_MAP = {
  "mp4": "video/mp4",
  "webm": "video/webm"
};
const DEFAULT_MIME_TYPE = "webm";
const CAPTURE_INTERVAL = 1000;

var mediaRecorder = null;
const active = Object.seal({
  "capturing": false,
  "index": -1,
  "frameUUID": FRAME_UUID,
  "canvas": null,
  "startTS": 0,
  "canvasRemoved": false
});
var chunks = null;
var frames = {[FRAME_UUID]: {"frameUUID": FRAME_UUID, "canvases": []}};
var numBytes = 0;
var objectURLs = [];
var downloadLinks = [];
var maxVideoSize = 4 * 1024 * 1024 * 1024;
const bodyMutObs = new MutationObserver(observeBodyMutations);
const canvasMutObs = new MutationObserver(observeCanvasMutations);
const CANVAS_OBSERVER_OPS = Object.freeze({
  "attributes": true,
  "attributeFilter": ["id", "width", "height"]
});

port.onMessage.addListener(onMessage);
window.addEventListener("message", handleWindowMessage, true);

bodyMutObs.observe(document.body, {
  "childList": true,
  "subtree": true
});

function handleWindowMessage(evt) {
  var msg = evt.data;

  if (msg.command === "identify") {
    let obj = JSON.parse(JSON.stringify(msg));
    obj.frameUUID = FRAME_UUID;
    evt.source.postMessage(obj, evt.origin);
  }
}

function onMessage(msg) {
  if (msg.command === MessageCommands.CAPTURE_START) {
    handleMessageCaptureStart(msg);
  } else if (msg.command === MessageCommands.CAPTURE_STOP) {
    preStopCapture();
  } else if (msg.command === MessageCommands.DISABLE) {
    freeObjectURLs();
  } else if (msg.command === MessageCommands.DISPLAY) {
    handleMessageDisplay(msg);
  } else if (msg.command === MessageCommands.DOWNLOAD) {
    handleMessageDownload(msg);
  } else if (msg.command === MessageCommands.HIGHLIGHT) {
    handleMessageHighlight(msg);
  } else if (msg.command === MessageCommands.REGISTER) {
    tabId = msg.tabId;
    frameId = msg.frameId;
  } else if (msg.command === MessageCommands.UPDATE_CANVASES) {
    let canvases = Array.from(document.body.querySelectorAll("canvas"));
    frames[FRAME_UUID].canvases = canvases;
    updateCanvases(canvases);
  }
}

function handleMessageCaptureStart(msg) {
  var ret = preStartCapture(msg);
  port.postMessage({
    "command": MessageCommands.CAPTURE_START,
    "tabId": tabId,
    "frameId": frameId,
    "frameUUID": FRAME_UUID,
    "targetFrameUUID": TOP_FRAME_UUID,
    "success": ret
  });
}

function handleMessageDisplay(msg) {
  var canvases = Array.from(document.body.querySelectorAll("canvas"));
  var canvasObsOps = {
    "attributes": true,
    "attributeFilter": ["id", "width", "height"]
  };

  canvases.forEach((canvas) => canvasMutObs.observe(canvas, canvasObsOps));
  maxVideoSize = msg.defaultSettings.maxVideoSize;
  tabId = msg.tabId;
  frames[FRAME_UUID].canvases = canvases;
  updateCanvases(canvases);
}

function handleMessageDownload(msg) {
  var link = document.createElement("a");
  link.textContent = "download";
  link.href = objectURLs[msg.canvasIndex];
  link.download = `capture-${parseInt(Date.now() / 1000, 10)}.${DEFAULT_MIME_TYPE}`;
  link.style.maxWidth = "0px";
  link.style.maxHeight = "0px";
  link.style.display = "block";
  link.style.visibility = "hidden";
  link.style.position = "absolute";
  downloadLinks.push(link);
  document.body.appendChild(link);
  link.click();
}

function handleMessageHighlight(msg) {
  var canvasIndex = msg.canvasIndex;
  var canvas = frames[FRAME_UUID].canvases[canvasIndex];
  var rect = canvas.getBoundingClientRect();

  port.postMessage({
    "command": MessageCommands.HIGHLIGHT,
    "tabId": tabId,
    "frameId": frameId,
    "frameUUID": FRAME_UUID,
    "targetFrameUUID": TOP_FRAME_UUID,
    "rect": {
      "left": rect.left,
      "top": rect.top,
      "right": rect.right,
      "bottom": rect.bottom,
      "width": rect.width,
      "height": rect.height,
      "x": rect.x,
      "y": rect.y
    },
    "canCapture": canCaptureStream(canvas)
  });
}

function observeBodyMutations(mutations) {
  var canvasesChanged = false;
  mutations = mutations.filter((el) => el.type === "childList");

  for (let k = 0, n = mutations.length; k < n; k += 1) {
    let mutation = mutations[k];

    let addedNodes = Array.from(mutation.addedNodes);
    for (let iK = 0, iN = addedNodes.length; iK < iN; iK += 1) {
      let node = addedNodes[iK];
      if (node.nodeName.toLowerCase() === "canvas") {
        canvasesChanged = true;
        break;
      }
    }

    let removedNodes = Array.from(mutation.removedNodes);
    for (let iK = 0, iN = removedNodes.length; iK < iN; iK += 1) {
      let node = removedNodes[iK];
      if (node.nodeName.toLowerCase() === "canvas") {
        canvasesChanged = true;
        if (active.capturing && node.classList.contains("canvas_active_capturing")) {
          active.canvasRemoved = true;
          preStopCapture();
          break;
        }
      }
    }
  }

  var canvases = Array.from(document.body.querySelectorAll("canvas"));
  frames[FRAME_UUID].canvases = canvases;

  if (canvasesChanged) {
    if (active.capturing && !active.canvasRemoved) {
      for (let k = 0, n = canvases.length; k < n; k += 1) {
        if (canvases[k].classList.contains("canvas_active_capturing")) {
          active.index = k;
          active.canvas = canvases[k];
          break;
        }
      }
    }

    updateCanvases(canvases);
  }
}

function observeCanvasMutations(mutations) {
  var canvases = Array.from(document.body.querySelectorAll("canvas"));
  mutations = mutations.filter((el) => el.type === "attributes");

  if (mutations.length) {
    updateCanvases(canvases);
  }
}

function updateCanvases(canvases) {
  var canvasData = canvases.map(function(el) {
    return {
      "id": el.id,
      "width": el.width,
      "height": el.height
    };
  });

  canvases.forEach((canvas) => canvasMutObs.observe(canvas, CANVAS_OBSERVER_OPS));

  port.postMessage({
    "command": MessageCommands.UPDATE_CANVASES,
    "tabId": tabId,
    "frameId": frameId,
    "frameUUID": FRAME_UUID,
    "targetFrameUUID": TOP_FRAME_UUID,
    "canvases": canvasData,
    "activeCanvasIndex": active.index
  });
}

function preStartCapture(msg) {
  if (active.capturing) {
    return false;
  }

  active.index = msg.canvasIndex;
  var canvas = frames[FRAME_UUID].canvases[active.index];
  var fps = msg.fps;
  var bps = msg.bps;

  if (!canCaptureStream(canvas)) {
    return false;
  }

  return startCapture(canvas, fps, bps);
}

function startCapture(canvas, fps, bps) {
  chunks = [];
  var stream = null;

  if (!canvas) {
    return false;
  }

  try {
    stream = canvas.captureStream(fps);
  } catch (e) {
    return false;
  }

  try {
    mediaRecorder = new MediaRecorder(
      stream,
      {"mimeType": MIME_TYPE_MAP[DEFAULT_MIME_TYPE], "bitsPerSecond": bps}
    );
  } catch (e) {
    mediaRecorder = new MediaRecorder(stream);
  }

  mediaRecorder.addEventListener("dataavailable", onDataAvailable, false);
  mediaRecorder.addEventListener("stop", stopCapture, false);
  mediaRecorder.start(CAPTURE_INTERVAL);
  active.capturing = true;
  active.startTS = Date.now();
  active.canvas = canvas;
  canvas.classList.add("canvas_active_capturing");

  return true;
}

function preStopCapture() {
  mediaRecorder.stop();
}

function stopCapture(evt, success) {
  var blob = null;
  var videoURL = "";

  if (chunks.length) {
    blob = new Blob(chunks, {"type": chunks[0].type});
    videoURL = window.URL.createObjectURL(blob);
    objectURLs[active.index] = videoURL;
  }
  success = (typeof success === "boolean") ? success : true;

  if (active.canvasRemoved) {
    port.postMessage({
      "command": MessageCommands.NOTIFY,
      "tabId": tabId,
      "frameId": frameId,
      "frameUUID": FRAME_UUID,
      "notification": "Canvas was removed while it was being recorded."
    });
    success = false;
  }

  port.postMessage({
    "command": MessageCommands.CAPTURE_STOP,
    "tabId": tabId,
    "frameId": frameId,
    "frameUUID": FRAME_UUID,
    "targetFrameUUID": TOP_FRAME_UUID,
    "canvasIndex": active.index,
    "videoURL": videoURL,
    "success": success,
    "size": blob ? blob.size : 0,
    "startTS": active.startTS
  });

  active.capturing = false;
  active.index = -1;
  active.canvas = null;
  active.startTS = 0;
  active.canvasRemoved = false;
  mediaRecorder = null;
  chunks = null;
}

function onDataAvailable(evt) {
  var blob = evt.data;

  if (blob.size) {
    chunks.push(blob);
    numBytes += blob.size;

    if (numBytes >= maxVideoSize) {
      preStopCapture();
    }
  }
}

function canCaptureStream(canvas) {
  try {
    if (canvas.captureStream(0)) {
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

function freeObjectURLs() {
  for (let k = 0; k < objectURLs.length; k += 1) {
    window.URL.revokeObjectURL(objectURLs[k]);
  }

  for (let k = 0, n = downloadLinks.length; k < n; k += 1) {
    let link = downloadLinks[k];
    link.parentElement.removeChild(link);
    downloadLinks[k] = null;
  }
  downloadLinks = [];
}

function genUUIDv4() {
  /* https://stackoverflow.com/a/2117523/1031545 */
  /* eslint-disable no-bitwise, id-length, no-mixed-operators */
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
  /* eslint-enable no-bitwise, id-length, no-mixed-operators */
}
}());
