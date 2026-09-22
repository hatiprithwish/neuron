export enum LogCategory {
  Route = "Route",
  DAL = "DAL",
  Repo = "Repo",
  Middleware = "Middleware",
  DB = "DB",
}

export enum LogAction {
  // Infra
  UnhandledError = "UnhandledError",

  // Auth
  VerifyToken = "VerifyToken",
  SyncClerkUser = "SyncClerkUser",
  SignOut = "SignOut",

  // User
  GetUserDetails = "GetUserDetails",
  UpdateUserDetails = "UpdateUserDetails",

  // Neuron — entities
  CreateEntity = "CreateEntity",
  GetEntityDetails = "GetEntityDetails",
  GetEntities = "GetEntities",
  UpdateEntity = "UpdateEntity",
  ArchiveEntity = "ArchiveEntity",
  UnarchiveEntity = "UnarchiveEntity",
  GetEntityRollup = "GetEntityRollup",
  GetEntityStats = "GetEntityStats",
  DeleteEntity = "DeleteEntity",

  // Neuron — metrics
  CreateMetric = "CreateMetric",
  GetMetricDetails = "GetMetricDetails",
  GetMetrics = "GetMetrics",
  GetMetricsUsage = "GetMetricsUsage",
  UpdateMetric = "UpdateMetric",
  DeleteMetric = "DeleteMetric",

  // Neuron — trackers
  CreateTracker = "CreateTracker",
  GetTrackerDetails = "GetTrackerDetails",
  GetTrackers = "GetTrackers",
  UpdateTracker = "UpdateTracker",
  ArchiveTracker = "ArchiveTracker",
  UnarchiveTracker = "UnarchiveTracker",
  DeleteTracker = "DeleteTracker",
  ReorderTrackers = "ReorderTrackers",

  // Neuron — tracker target history (a target is a value *from a date*, not one number)
  CreateTrackerTarget = "CreateTrackerTarget",
  GetTrackerTargets = "GetTrackerTargets",
  DeleteTrackerTarget = "DeleteTrackerTarget",

  // Neuron — tracker plans (if-then triggers) and moments (a trigger firing)
  CreateTrackerPlan = "CreateTrackerPlan",
  GetTrackerPlans = "GetTrackerPlans",
  UpdateTrackerPlan = "UpdateTrackerPlan",
  DeleteTrackerPlan = "DeleteTrackerPlan",
  CreateTrackerMoment = "CreateTrackerMoment",
  GetTrackerMoments = "GetTrackerMoments",
  DeleteTrackerMoment = "DeleteTrackerMoment",

  // Neuron — entries
  WriteEntry = "WriteEntry",
  RekeyEntryDays = "RekeyEntryDays",
  GetEntries = "GetEntries",
  GetEntriesWithParts = "GetEntriesWithParts",
  DeleteEntry = "DeleteEntry",
  GetDailyFacts = "GetDailyFacts",
  UpdateEntryEndedAt = "UpdateEntryEndedAt",
  AppendEntryValue = "AppendEntryValue",
  GetOpenIntervalEntry = "GetOpenIntervalEntry",
  GetIntervalBreakdown = "GetIntervalBreakdown",
  GetDailyFactsForMetrics = "GetDailyFactsForMetrics",

  // Manifest engine — generic tracker surfaces (replaced the per-domain Habits/Money/Time actions)
  QuickAddEntry = "QuickAddEntry",
  GetTrackerHeatmap = "GetTrackerHeatmap",
  GetTrackerBreakdown = "GetTrackerBreakdown",
  GetTrackerTimeline = "GetTrackerTimeline",
  RunCompute = "RunCompute",

  // Neuron — daily log (one free-form note per user per day)
  UpsertDailyLog = "UpsertDailyLog",
  GetDailyLog = "GetDailyLog",
  GetDailyLogs = "GetDailyLogs",
  DeleteDailyLog = "DeleteDailyLog",

  // Infra — weekly orphan scan (architecture.md §4.1)
  RunOrphanScan = "RunOrphanScan",
  OrphanRowsDetected = "OrphanRowsDetected",

  // Notifications (PR 2: push plumbing; PR 3/4: dispatch, added together so later PRs don't touch
  // this file again)
  CreatePushSubscription = "CreatePushSubscription",
  GetPushSubscriptions = "GetPushSubscriptions",
  DeletePushSubscription = "DeletePushSubscription",
  PrunePushSubscription = "PrunePushSubscription",
  GetNotificationPrefs = "GetNotificationPrefs",
  UpsertNotificationPrefs = "UpsertNotificationPrefs",
  SendWebPush = "SendWebPush",
  SendTestNotification = "SendTestNotification",
  GetSubscribedUserIds = "GetSubscribedUserIds",
  GetTrackersDueForReminder = "GetTrackersDueForReminder",
  GetOpenIntervalsForUsers = "GetOpenIntervalsForUsers",
  ClaimNotificationSend = "ClaimNotificationSend",
  RunNotificationDispatch = "RunNotificationDispatch",
  UnknownCronTrigger = "UnknownCronTrigger",
}
