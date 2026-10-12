// Shown the instant a section is tapped (Next prefetches this boundary), so
// switching tabs in the phone app responds immediately instead of waiting
// for the server round trip before anything changes on screen.
export default function DashboardLoading() {
  return (
    <div className="flex flex-1 items-center justify-center py-24">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  );
}
