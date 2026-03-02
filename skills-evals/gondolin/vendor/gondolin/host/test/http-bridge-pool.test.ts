import assert from "node:assert/strict";
import test from "node:test";
import { VM, createHttpHooks } from "../src/index.ts";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { hasGuestAssets } from "../src/assets.ts";
import { shouldSkipVmTests } from "./helpers/vm-fixture.ts";

const vmSkipReason = shouldSkipVmTests()
  ? "hardware virtualization unavailable"
  : !hasGuestAssets()
    ? "guest assets missing (run make build first or set GONDOLIN_GUEST_DIR)"
    : false;

const timeoutMs = Number(process.env.WS_TIMEOUT ?? 120000);

test(
  "http bridge evicts dispatcher when guest closes socket mid-stream during POST",
  { skip: vmSkipReason, timeout: timeoutMs },
  async () => {
    let server: http.Server | undefined;
    let vm: VM | undefined;

    try {
      server = http.createServer((req, res) => {
        const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        if (pathname === "/probe") {
          const body = Buffer.from("probe-ok");
          res.writeHead(200, {
            "Content-Type": "text/plain",
            "Content-Length": body.length.toString(),
          });
          res.end(body);
          return;
        }

        if (pathname !== "/stream") {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("not found");
          return;
        }

        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": "1000000000", // Tell curl to expect 1GB
        });

        const chunk = Buffer.alloc(1024 * 1024, "A");
        let closed = false;
        const stopStream = () => {
          if (closed) return;
          closed = true;
          clearInterval(interval);
        };

        const interval = setInterval(() => {
          if (closed) return;
          res.write(chunk);
        }, 1);

        req.on("data", () => {});
        req.on("aborted", stopStream);
        req.on("close", stopStream);
        req.on("error", stopStream);
        res.on("close", stopStream);
        res.on("error", stopStream);
      });

      await new Promise<void>((resolve) =>
        server!.listen(0, "127.0.0.1", resolve),
      );
      const port = (server.address() as AddressInfo).port;

      vm = new VM({
        httpHooks: createHttpHooks({
          allowAllIps: true,
          allowAllRequests: true,
          onRequest: async (req) => {
            const url = new URL(req.url);
            if (url.hostname === "10.0.2.2") {
              url.hostname = "127.0.0.1";
              return new Request(url.toString(), req);
            }
            return req;
          },
        }),
      });

      const streamUrl = `http://10.0.2.2:${port}/stream`;
      const probeUrl = `http://10.0.2.2:${port}/probe`;
      const hostHeader = `Host: 127.0.0.1:${port}`;

      // Create a 50MB dummy file for POST upload
      await vm.exec([
        "/bin/sh",
        "-c",
        "dd if=/dev/zero of=/tmp/large_file.bin bs=1M count=50",
      ]);

      const exec1Promise = vm.exec([
        "/bin/sh",
        "-c",
        `timeout 1 curl -s -v --show-error --fail -H "${hostHeader}" -d "@/tmp/large_file.bin" ${streamUrl} -o /dev/null`,
      ]);

      const exec1 = await Promise.race([
        exec1Promise,
        new Promise<any>((resolve) =>
          setTimeout(
            () => resolve({ exitCode: -1, stderr: "TIMEOUT", stdout: "" }),
            15000,
          ),
        ),
      ]);

      assert.notEqual(exec1.exitCode, -1, "Guest client 1 hung the host");
      // timeout exits with 143 (SIGTERM)
      assert.notEqual(exec1.exitCode, 0, "Guest client 1 did not timeout");

      // Wait for TCP tear down
      await new Promise((r) => setTimeout(r, 1000));

      const exec2 = await vm.exec([
        "/bin/sh",
        "-c",
        `curl -sS --show-error --fail --max-time 5 -H "${hostHeader}" ${probeUrl}`,
      ]);

      assert.equal(
        exec2.exitCode,
        0,
        "Second request should succeed with a fresh connection",
      );
      assert.equal(exec2.stdout.trim(), "probe-ok");
    } finally {
      if (vm) await vm.close();
      if (server) {
        server.closeAllConnections();
        server.close();
      }
    }
  },
);
