import { Router } from "express";
import { defineAppRouter } from "../../../../src/core";

// Test fixture: the smallest possible app router, with a KV round trip.
export default defineAppRouter(({ id, kv }) => {
  const router = Router();
  router.get("/ping", (_req, res) => {
    res.json({ app: id, pong: true });
  });
  router.put("/note", (req, res) => {
    kv.set("note", req.body);
    res.json({ saved: true });
  });
  router.get("/note", (_req, res) => {
    res.json({ note: kv.get("note") ?? null });
  });
  return router;
});
