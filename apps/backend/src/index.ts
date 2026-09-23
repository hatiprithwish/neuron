import { honoLogger } from "@logtape/hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import AppLogger, { configureLogger, disposeLogger, withRequestContext } from "@/providers/logger";
import AuthRoutes from "@/routes/AuthRoutes";
import UsersRoutes from "@/routes/UserRoutes";
import TrackersRoutes from "@/routes/TrackersRoutes";
import TrackerPlansRoutes from "@/routes/TrackerPlansRoutes";
import EntitiesRoutes from "@/routes/EntitiesRoutes";
import MetricsRoutes from "@/routes/MetricsRoutes";
import NotificationsRoutes from "@/routes/NotificationsRoutes";
import DailyLogsRoutes from "@/routes/DailyLogsRoutes";
import MediaRoutes from "@/routes/MediaRoutes";
import OrphanScanRepo from "@/repositories/OrphanScanRepo";
import NotificationsRepo from "@/repositories/NotificationsRepo";
import * as Schemas from "@app/schemas";
import Constants from "@/config/Constants";

// DEV_NOTE: Configure logger at the top level to ensure it's ready before handling any requests
await configureLogger();

const app = new Hono<{ Bindings: Env }>();

app.use((c, next) =>
  cors({
    origin: (origin) => {
      const allowed = c.env.ALLOWED_CORS_ORIGIN.split(",");
      return allowed.includes(origin) ? origin : null;
    },
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "x-request-id"],
    exposeHeaders: ["x-request-id"],
    maxAge: 7200,
    credentials: true,
  })(c, next),
);
app.use(requestId({ headerName: "x-request-id" }));

app.use(async (c, next) => {
  await withRequestContext(c.get("requestId"), next);
});

app.use(
  honoLogger({
    category: [Constants.APP_NAME, Schemas.LogCategory.Middleware],
    level: "info",
  }),
);

app.route("/auth", AuthRoutes);
app.route("/users", UsersRoutes);
// DEV_NOTE: the manifest engine's three surfaces replaced /habits, /money and /time — a tracker is
// a row whose manifest says what it is (architecture.md §7 step 4), entities are the shared named
// things any tracker links entries to, and metrics is what "reuse a metric" reads from.
app.route("/trackers/:trackerPublicId", TrackerPlansRoutes);
app.route("/trackers", TrackersRoutes);
app.route("/entities", EntitiesRoutes);
app.route("/metrics", MetricsRoutes);
app.route("/notifications", NotificationsRoutes);
app.route("/daily-log", DailyLogsRoutes);
app.route("/media", MediaRoutes);

// DEV_NOTE: last-resort net for exceptions thrown outside a DAL's try/catch (e.g. a third-party
// SDK call in a route handler) — without this, Hono's default 500 has no body and the Workers
// log carries no error message, exactly what made the clerk-sync 500 undiagnosable.
app.onError((error, c) => {
  AppLogger.error({
    category: Schemas.LogCategory.Route,
    action: Schemas.LogAction.UnhandledError,
    message: `Unhandled error on ${c.req.method} ${c.req.path}`,
    error,
  });
  return c.json({ isSuccess: false, message: "Internal server error" }, 500);
});

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(disposeLogger());
    return app.fetch(req, env, ctx);
  },
  // DEV_NOTE: two cron triggers now (see wrangler.jsonc's triggers.crons and Constants.ts) —
  // Cloudflare invokes scheduled() once per configured expression with controller.cron set to that
  // expression string exactly as configured, so the switch dispatches on the literal string rather
  // than inferring which job from the time. No HTTP surface for either job, so this bypasses the
  // Hono app entirely and calls the Repo directly.
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // DEV_NOTE: the module-level `await configureLogger()` above already ran before this handler
    // can be invoked — mirrors fetch(), which only ever disposes, never re-configures.
    switch (controller.cron) {
      case Constants.CRON_ORPHAN_SCAN:
        ctx.waitUntil(new OrphanScanRepo(env).runScan().then(() => disposeLogger()));
        break;
      case Constants.CRON_NOTIFICATION_DISPATCH:
        // DEV_NOTE: scheduledTime, not Date.now() — a delayed or retried invocation must still
        // resolve to the hour it was scheduled for (see NotificationsRepo.runHourlyDispatch).
        ctx.waitUntil(
          new NotificationsRepo(env)
            .runHourlyDispatch({ at: new Date(controller.scheduledTime) })
            .then(() => disposeLogger()),
        );
        break;
      default:
        AppLogger.error({
          category: Schemas.LogCategory.Route,
          action: Schemas.LogAction.UnknownCronTrigger,
          message: `Unknown cron trigger: ${controller.cron}`,
          metadata: { cron: controller.cron },
        });
        ctx.waitUntil(disposeLogger());
    }
  },
};
