import { Hono } from "hono";
import DailyLogsRepo from "@/repositories/DailyLogsRepo";
import checkAuth from "@/middlewares/AuthMiddleware";
import type AppContext from "@/config/AppContext";
import * as Schemas from "@app/schemas";
import { zValidator } from "@hono/zod-validator";

// DEV_NOTE: a daily log is addressed by its calendar day, not its publicId — there is exactly one
// per user per day, and "the log for 2026-09-22" is how every screen asks for it. localDate is a
// date, not an identity key, so this doesn't bend the publicId-only rule for ids.
const DailyLogsRoutes = new Hono<AppContext>();

DailyLogsRoutes.get(
  "/",
  checkAuth,
  zValidator("query", Schemas.ZGetDailyLogsApiQuery),
  async (c) => {
    const userId = c.get("clerkUserId");
    const { from, to } = c.req.valid("query");

    const repo = new DailyLogsRepo(c.env);
    const response = await repo.getDailyLogs({ userId, from, to });

    return c.json(response, response.isSuccess ? 200 : 400);
  },
);

DailyLogsRoutes.get(
  "/:localDate",
  checkAuth,
  zValidator("param", Schemas.ZDailyLogLocalDateParam),
  async (c) => {
    const userId = c.get("clerkUserId");
    const { localDate } = c.req.valid("param");

    const repo = new DailyLogsRepo(c.env);
    const response = await repo.getDailyLog({ userId, localDate });

    return c.json(response, response.isSuccess ? 200 : 500);
  },
);

DailyLogsRoutes.put(
  "/:localDate",
  checkAuth,
  zValidator("param", Schemas.ZDailyLogLocalDateParam),
  zValidator("json", Schemas.ZUpsertDailyLogApiRequest),
  async (c) => {
    const userId = c.get("clerkUserId");
    const { localDate } = c.req.valid("param");
    const body = c.req.valid("json");

    const repo = new DailyLogsRepo(c.env);
    const response = await repo.upsertDailyLog({ userId, localDate, body });

    return c.json(response, response.isSuccess ? 200 : 400);
  },
);

DailyLogsRoutes.delete(
  "/:localDate",
  checkAuth,
  zValidator("param", Schemas.ZDailyLogLocalDateParam),
  async (c) => {
    const userId = c.get("clerkUserId");
    const { localDate } = c.req.valid("param");

    const repo = new DailyLogsRepo(c.env);
    const response = await repo.deleteDailyLog({ userId, localDate });

    return c.json(response, response.isSuccess ? 200 : 404);
  },
);

export default DailyLogsRoutes;
