"""Diag: screenshot sandbox page via raw CDP websocket (no browser_harness)."""
import json, base64, time, os
import urllib.request
os.environ['NO_PROXY'] = '127.0.0.1,localhost'
os.environ['no_proxy'] = '127.0.0.1,localhost'
import websocket  # noqa: E402

ver = json.load(urllib.request.urlopen("http://127.0.0.1:9222/json/version"))
ws = websocket.create_connection(ver["webSocketDebuggerUrl"], timeout=40)
_id = [0]


def send(method, params=None, sid=None):
    _id[0] += 1
    i = _id[0]
    msg = {"id": i, "method": method, "params": params or {}}
    if sid:
        msg["sessionId"] = sid
    ws.send(json.dumps(msg))
    while True:
        r = json.loads(ws.recv())
        if r.get("id") == i:
            return r.get("result", {})


t = send("Target.createTarget", {"url": "http://127.0.0.1:5173/"})["targetId"]
s = send("Target.attachToTarget", {"targetId": t, "flatten": True})["sessionId"]
time.sleep(12)
r = send("Page.captureScreenshot", {"format": "png"}, sid=s)
open("/tmp/sandbox-fs.png", "wb").write(base64.b64decode(r["data"]))
print("saved")
send("Target.closeTarget", {"targetId": t})
ws.close()
