import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import getDbClient from "@/db/dbClient";
import { users } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

export default class UsersDAL {
  private db: DrizzleD1Database;

  constructor(env: Env) {
    this.db = getDbClient(env);
  }

  async getUserDetails(params: { clerkId: string }) {
    const response: Schemas.GetUserDetailsApiResponse = {
      isSuccess: false,
    };

    try {
      const [user] = await this.db
        .select()
        .from(users)
        .where(eq(users.clerkId, params.clerkId))
        .limit(1);

      if (!user) {
        const message = "User not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GetUserDetails,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "User details fetched successfully";
      response.user = {
        publicId: user.publicId,
        clerkId: user.clerkId,
        email: user.email,
        tz: user.tz,
        homeCurrency: user.homeCurrency,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        role: user.role,
      };
    } catch (error) {
      const message = "Unknown error in fetching user details";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetUserDetails,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }
    return response;
  }

  async upsertUser(params: Schemas.SyncClerkUserApiRequest) {
    const response: Schemas.SyncClerkUserApiResponse = {
      isSuccess: false,
    };
    try {
      const now = new Date();

      await this.db
        .insert(users)
        .values({
          publicId: Utility.generatePublicId("usr_"),
          clerkId: params.clerkId,
          email: params.email,
          role: params.role,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: users.clerkId,
          set: {
            email: params.email,
            updatedAt: now,
          },
        });

      const userDetailsResponse = await this.getUserDetails({
        clerkId: params.clerkId,
      });

      if (!userDetailsResponse.user) {
        const message = "Failed to fetch user after upsert";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.SyncClerkUser,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      response.isSuccess = true;
      response.message = "User synced successfully";
      response.user = userDetailsResponse.user;
    } catch (error) {
      const message = "Unknown error in syncing clerk user";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.SyncClerkUser,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }
    return response;
  }

  async updateUser(params: Schemas.UpdateUserDALRequest) {
    const response: Schemas.UpdateUserApiResponse = { isSuccess: false };

    try {
      const now = new Date();

      await this.db
        .update(users)
        .set({ ...params.fields, updatedAt: now })
        .where(eq(users.clerkId, params.clerkId));

      const userDetailsResponse = await this.getUserDetails({ clerkId: params.clerkId });

      if (!userDetailsResponse.user) {
        const message = "User not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.UpdateUserDetails,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      response.isSuccess = true;
      response.message = "User updated successfully";
      response.user = userDetailsResponse.user;
    } catch (error) {
      const message = "Unknown error in updating user";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.UpdateUserDetails,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }
    return response;
  }

  // DEV_NOTE: the dispatcher's clerk_id lookup — resolves a chunk of the unscoped user id set
  // (NotificationsDAL.getSubscribedUserIds) to the one thing it needs from `users`: the timezone
  // that decides when to fire (see DateTime.ts). No join; this repo's convention is a clerk_id
  // lookup, same as getUserDetails.
  async getUsersByClerkIds(params: { clerkIds: string[] }) {
    const response: Schemas.ApiResponse & { users?: Pick<Schemas.User, "clerkId" | "tz">[] } = {
      isSuccess: false,
    };

    if (params.clerkIds.length === 0) {
      response.isSuccess = true;
      response.users = [];
      return response;
    }

    try {
      const usersResponse: Pick<Schemas.User, "clerkId" | "tz">[] = [];
      for (const clerkIds of Utility.chunk(params.clerkIds)) {
        const rows = await this.db
          .select({ clerkId: users.clerkId, tz: users.tz })
          .from(users)
          .where(and(inArray(users.clerkId, clerkIds), isNull(users.deletedAt)));
        usersResponse.push(...rows);
      }

      response.isSuccess = true;
      response.message = "Users fetched successfully";
      response.users = usersResponse;
    } catch (error) {
      const message = "Unknown error in fetching users by clerk id";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetUserDetails,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }
}
