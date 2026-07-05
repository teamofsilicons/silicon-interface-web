import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Delete your account — Silicon Interface",
  description:
    "How to delete your Silicon Interface account and data — in the app or by request, and exactly what is deleted.",
  alternates: {
    canonical: "https://interface.teamofsilicons.com/delete-account",
  },
};

// Google Play requires a public web page where users can request account +
// data deletion; this is the URL declared in the Play Console.
export default function DeleteAccountPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 pb-24 pt-10">
      <p className="label-mono text-xs uppercase tracking-widest text-muted-foreground">
        your data
      </p>
      <h1 className="mt-2 text-4xl font-bold tracking-tight">Delete your account</h1>
      <p className="mt-3 text-[15.5px] text-muted-foreground">
        For Silicon Interface (Android, iOS, web) by <strong>Team of Silicons</strong>.
        Deletion is immediate and permanent — there is no undo.
      </p>

      <div className="mt-8 space-y-6 text-[15.5px] leading-relaxed">
        <section className="border border-border bg-bubble-received p-5">
          <h2 className="text-xl font-bold">Fastest: delete in the app</h2>
          <ol className="mt-3 list-decimal space-y-2 pl-6">
            <li>Open Silicon Interface and sign in.</li>
            <li>
              Go to <strong>Settings</strong> (tap your avatar).
            </li>
            <li>
              Under <strong>Account</strong>, tap <strong>Delete account</strong>.
            </li>
            <li>Confirm. Your account and data are deleted immediately.</li>
          </ol>
        </section>

        <section className="border border-border bg-bubble-received p-5">
          <h2 className="text-xl font-bold">Don&apos;t have the app anymore?</h2>
          <p className="mt-3">
            Email us from the address on your account (or include your account phone
            number so we can verify it&apos;s you):
          </p>
          <p className="mt-4">
            <a
              href="mailto:silicon@unlikefraction.com?subject=Delete%20my%20Silicon%20Interface%20account"
              className="inline-block bg-primary px-5 py-3 font-semibold text-primary-foreground"
            >
              Request deletion by email
            </a>
          </p>
          <p className="mt-4">
            We verify the request against your registered phone number or email and
            complete the deletion within <strong>30 days</strong> (usually much sooner).
            We&apos;ll confirm when it&apos;s done.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold">What gets deleted, what&apos;s retained</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="border border-border p-4">
              <h3 className="font-semibold">Deleted immediately</h3>
              <ul className="mt-2 list-disc space-y-1.5 pl-5">
                <li>Phone number, email, username, display name, tagline</li>
                <li>Profile photos</li>
                <li>Photos, videos, files, and voice messages you uploaded</li>
                <li>Saved contacts (yours, and others&apos; entries for you)</li>
                <li>Room, group, and team memberships</li>
                <li>Push notification tokens and signed-in sessions</li>
              </ul>
            </div>
            <div className="border border-border p-4">
              <h3 className="font-semibold">Retained</h3>
              <ul className="mt-2 list-disc space-y-1.5 pl-5">
                <li>
                  Messages you sent to other people stay in <em>their</em> conversations,
                  permanently anonymized as &quot;Deleted user&quot; — nothing identifying
                  you remains attached to them
                </li>
                <li>
                  Records we&apos;re legally required to keep (e.g. invoices for paid
                  team plans), for the statutory period
                </li>
              </ul>
            </div>
          </div>
        </section>

        <p className="text-sm text-muted-foreground">
          Questions? See our{" "}
          <Link href="/privacy" className="underline">
            Privacy Policy
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
