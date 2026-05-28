// template.tsx (root) — wraps every page render in a fresh element on each
// navigation, so the .page-enter animation in globals.css re-fires every time
// the route changes. Layouts persist across routes; templates do not.

export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="page-enter">{children}</div>;
}
