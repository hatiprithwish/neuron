import { Hono } from "hono";
import MediaRepo from "@/repositories/MediaRepo";
import checkAuth from "@/middlewares/AuthMiddleware";
import type AppContext from "@/config/AppContext";
import * as Schemas from "@app/schemas";
import { zValidator } from "@hono/zod-validator";

const MediaRoutes = new Hono<AppContext>();

// DEV_NOTE: multipart, so no zValidator on the body — MediaRepo checks the type and size of the
// part itself. The origin is taken from the request so the stored URL matches whichever host the
// client reached (local, staging, production).
MediaRoutes.post("/", checkAuth, async (c) => {
  const userId = c.get("clerkUserId");

  const form = await c.req.formData();
  const file = form.get(Schemas.MEDIA_UPLOAD_FIELD);

  if (!(file instanceof File)) {
    return c.json({ isSuccess: false, message: "No file was uploaded" }, 400);
  }

  const repo = new MediaRepo(c.env);
  const response = await repo.uploadMedia({ userId, file, origin: new URL(c.req.url).origin });

  return c.json(response, response.isSuccess ? 201 : 400);
});

// DEV_NOTE: deliberately unauthenticated — an <img src> carries no bearer token, and the web app
// is a different origin, so no cookie either. The 32-character publicId is the capability: holding
// the URL is what grants access to that one image. Immutable caching because the bytes behind a
// publicId never change (an edit uploads a new object).
MediaRoutes.get("/:publicId", zValidator("param", Schemas.ZMediaPublicIdParam), async (c) => {
  const { publicId } = c.req.valid("param");

  const repo = new MediaRepo(c.env);
  const response = await repo.getMediaBody({ publicId });

  if (!response.isSuccess || !response.body) {
    return c.json({ isSuccess: false, message: response.message }, response.isNotFound ? 404 : 500);
  }

  return new Response(response.body, {
    headers: {
      "Content-Type": response.contentType ?? "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});

export default MediaRoutes;
