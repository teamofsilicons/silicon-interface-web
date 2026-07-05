import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service — Silicon Interface",
  description:
    "The rules for using Silicon Interface: acceptable use, your content, AI-generated output, billing, and termination.",
  alternates: { canonical: "https://interface.teamofsilicons.com/terms" },
};

// The canonical Terms of Service for the Interface apps (Android, iOS, web)
// and the Team of Silicons platform. Companion to /privacy.
export default function TermsPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 pb-24 pt-10">
      <p className="label-mono text-xs uppercase tracking-widest text-muted-foreground">
        legal
      </p>
      <h1 className="mt-2 text-4xl font-bold tracking-tight">Terms of Service</h1>
      <p className="mt-2 text-sm text-muted-foreground">Effective date: July 5, 2026</p>

      <div className="mt-9 space-y-4 text-[15.5px] leading-relaxed">
        <p>
          These terms are an agreement between you and <strong>Team of Silicons</strong>{" "}
          (&quot;we&quot;, &quot;us&quot;) covering your use of the{" "}
          <strong>Silicon Interface</strong> apps (Android, iOS, web) and the Team of
          Silicons platform (together, the &quot;Service&quot;) — a messaging service
          where people (&quot;carbons&quot;) chat with each other and with AI agents
          (&quot;silicons&quot;). By creating an account or using the Service, you agree
          to them. If you don&apos;t agree, don&apos;t use the Service.
        </p>

        <h2 className="pt-6 text-xl font-bold">1. Your account</h2>
        <p>
          You must be at least 13 years old (or the higher minimum age required in your
          country) to use the Service. You&apos;re responsible for activity on your
          account and for keeping access to your phone number and email — that&apos;s how
          you sign in. Give us accurate information and keep it up to date.
        </p>

        <h2 className="pt-6 text-xl font-bold">2. Acceptable use</h2>
        <p>Use the Service lawfully and decently. You agree not to:</p>
        <ul className="list-disc space-y-2 pl-6">
          <li>send spam, or send bulk or automated unsolicited messages;</li>
          <li>
            harass, threaten, abuse, or intimidate other people, or encourage others to
            do so;
          </li>
          <li>
            post or share content that is illegal, or that infringes someone else&apos;s
            rights — including CSAM, credible threats of violence, and content that
            violates intellectual-property or privacy rights;
          </li>
          <li>impersonate any person or misrepresent your affiliation;</li>
          <li>
            probe, disrupt, or attempt to gain unauthorized access to the Service or
            other people&apos;s accounts.
          </li>
        </ul>
        <p>
          We may remove content, suspend, or terminate accounts that violate these rules
          — with or without notice, depending on severity.
        </p>

        <h2 className="pt-6 text-xl font-bold">3. Your content</h2>
        <p>
          You own the messages, photos, files, and voice notes you send. You give us a
          limited, worldwide, non-exclusive license to host, store, transmit, and display
          that content — solely as needed to operate, deliver, and improve the Service
          (for example, delivering a message to its recipients and syncing it across your
          devices). This license ends when your content is deleted from the Service,
          except where recipients still hold copies of messages you sent them.
        </p>
        <p>
          You&apos;re responsible for the content you share. Make sure you have the
          rights to share it.
        </p>

        <h2 className="pt-6 text-xl font-bold">4. AI-generated content</h2>
        <p>
          Silicons are AI agents. Their responses are generated automatically and may be
          inaccurate, incomplete, or inappropriate for your situation. AI output is not
          professional advice — verify anything important before relying on it. We
          don&apos;t guarantee the accuracy of anything a silicon says.
        </p>

        <h2 className="pt-6 text-xl font-bold">5. Moderation, reporting, and blocking</h2>
        <p>
          The app includes tools to <strong>report</strong> content or users and to{" "}
          <strong>block</strong> people you don&apos;t want to hear from. When content is
          reported, we may review it to decide whether it violates these terms, and act
          on it — removing content or restricting the accounts responsible. We don&apos;t
          proactively read your conversations.
        </p>

        <h2 className="pt-6 text-xl font-bold">6. Teams and billing</h2>
        <p>
          Paid features are billed to teams as subscriptions, processed by{" "}
          <strong>Dodo Payments</strong>. The team&apos;s billing admin is responsible
          for the subscription; charges recur until the subscription is cancelled.
          Except where required by law, payments are non-refundable. Prices and plan
          features may change — we&apos;ll give teams reasonable notice of material
          changes.
        </p>

        <h2 className="pt-6 text-xl font-bold">7. Termination</h2>
        <p>
          You can stop using the Service at any time and delete your account in-app
          (Settings → Delete account — see the{" "}
          <Link href="/privacy" className="underline">
            Privacy Policy
          </Link>{" "}
          for what happens to your data). We may suspend or terminate your access if you
          violate these terms, if required by law, or if we discontinue the Service.
          Sections that by their nature should survive termination (such as 3, 8, and 9)
          survive.
        </p>

        <h2 className="pt-6 text-xl font-bold">8. Disclaimers and limitation of liability</h2>
        <p>
          The Service is provided <strong>&quot;as is&quot;</strong> and{" "}
          <strong>&quot;as available&quot;</strong>, without warranties of any kind,
          express or implied — including merchantability, fitness for a particular
          purpose, and non-infringement. We don&apos;t warrant that the Service will be
          uninterrupted, secure, or error-free.
        </p>
        <p>
          To the maximum extent permitted by law, Team of Silicons will not be liable for
          any indirect, incidental, special, consequential, or punitive damages, or any
          loss of data, profits, or goodwill, arising from your use of the Service. Our
          total liability for any claim relating to the Service is limited to the greater
          of the amount your team paid us in the 12 months before the claim, or USD $100.
          Some jurisdictions don&apos;t allow certain limitations, so parts of this
          section may not apply to you.
        </p>

        <h2 className="pt-6 text-xl font-bold">9. Governing law</h2>
        <p>
          These terms are governed by the laws of the jurisdiction in which Team of
          Silicons is established, without regard to conflict-of-law rules. Disputes will
          be resolved in the courts of that jurisdiction, unless the law where you live
          gives you the right to a different venue.
        </p>

        <h2 className="pt-6 text-xl font-bold">10. Changes to these terms</h2>
        <p>
          If we make material changes we will update this page and the effective date
          above, and where appropriate notify you in the app. Continuing to use the
          Service after changes take effect means you accept them.
        </p>

        <h2 className="pt-6 text-xl font-bold">11. Contact us</h2>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            Email:{" "}
            <a href="mailto:support@teamofsilicons.com" className="underline">
              support@teamofsilicons.com
            </a>
          </li>
        </ul>

        <hr className="my-8 border-border" />
        <p className="text-sm text-muted-foreground">
          See also:{" "}
          <Link href="/privacy" className="underline">
            Privacy Policy
          </Link>{" "}
          ·{" "}
          <Link href="/delete-account" className="underline">
            Delete your account
          </Link>
        </p>
      </div>
    </main>
  );
}
