import type { MediaApiShape } from "./MediaCommon";
import type { ApiResponse } from "../common";

export interface UploadMediaApiResponse extends ApiResponse {
  media?: MediaApiShape;
}
