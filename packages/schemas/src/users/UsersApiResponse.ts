import type { User } from "./UsersCommon";
import type { ApiResponse } from "../common";

export interface SyncClerkUserApiResponse extends ApiResponse {
  user?: User;
}

// DEV_NOTE: isNotFound separates "no users row for this Clerk id" (404 — typically clerk-sync
// hasn't landed yet on a first sign-in) from a DB failure (500), which both leave `user` absent.
export interface GetUserDetailsApiResponse extends ApiResponse {
  user?: User;
  isNotFound?: boolean;
}

export interface UpdateUserApiResponse extends ApiResponse {
  user?: User;
}
