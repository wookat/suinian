"""Read-only CDP observations/screenshots; no auth values are printed."""
import asyncio, base64, json, sys, urllib.request
import websockets

async def main():
    tabs = json.load(urllib.request.urlopen("http://localhost:29229/json/list"))
    tab = next(t for t in tabs if t["type"] == "page" and "suinian.zalize.com" in t["url"])
    async with websockets.connect(tab["webSocketDebuggerUrl"], origin=None, max_size=20000000) as ws:
        snap = sys.argv[1] == "snap"
        method = "Page.captureScreenshot" if snap else "Runtime.evaluate"
        params = {"format": "png"} if snap else {"expression": sys.stdin.read(), "awaitPromise": True, "returnByValue": True}
        await ws.send(json.dumps({"id": 1, "method": method, "params": params}))
        while True:
            r = json.loads(await ws.recv())
            if r.get("id") != 1:
                continue
            if snap:
                open(sys.argv[2], "wb").write(base64.b64decode(r["result"]["data"]))
                print(sys.argv[2])
            else:
                print(json.dumps(r.get("result", {}), ensure_ascii=False))
            break

asyncio.run(main())
