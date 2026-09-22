import { createFileRoute } from "@tanstack/react-router";
import { useAuth } from "@clerk/tanstack-react-start";
import DailyLogDay from "../-DailyLogDay";

// DEV_NOTE: any day other than today — reached from the past-days list or the previous/next
// arrows. The param is validated inside DailyLogDay (malformed or future days get a message, not
// an editor), so a hand-typed URL can't create a log for a day that hasn't happened.
export const Route = createFileRoute("/_authenticated/daily-log/$localDate/")({
  component: DailyLogDayPage,
});

function DailyLogDayPage() {
  const { getToken } = useAuth();
  const { localDate } = Route.useParams();
  return <DailyLogDay localDate={localDate} getToken={getToken} />;
}
