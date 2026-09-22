import { createFileRoute } from "@tanstack/react-router";
import { useAuth } from "@clerk/tanstack-react-start";
import { getTodayLocalDate } from "../trackers/-utils";
import DailyLogDay from "./-DailyLogDay";

// DEV_NOTE: one free-form note per day — the user's own words about their day, Notion-style blocks.
// This route is always today (in users.tz, same as the backend's localDateIn); past days live at
// /daily-log/$localDate.
export const Route = createFileRoute("/_authenticated/daily-log/")({
  component: DailyLogTodayPage,
});

function DailyLogTodayPage() {
  const { getToken } = useAuth();
  return <DailyLogDay localDate={getTodayLocalDate()} getToken={getToken} />;
}
