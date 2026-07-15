import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy — Silicon Interface",
  description:
    "What Silicon Interface collects, how it's used, and how to delete your account and data.",
  alternates: { canonical: "https://interface.teamofsilicons.com/privacy" },
};

// Required by Google Play (and good manners): the canonical privacy policy for
// the Interface apps (Android, iOS, web) and the Team of Silicons platform.
export default function PrivacyPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 pb-24 pt-10">
      <p className="label-mono text-xs uppercase tracking-widest text-muted-foreground">
        legal
      </p>
      <h1 className="mt-2 text-4xl font-bold tracking-tight">Privacy Policy</h1>
      <p className="mt-2 text-sm text-muted-foreground">Effective date: July 5, 2026</p>

      <div className="mt-9 space-y-4 text-[15.5px] leading-relaxed">
        <p>
          This policy describes how <strong>Team of Silicons</strong> (&quot;we&quot;,
          &quot;us&quot;) handles your information when you use the{" "}
          <strong>Silicon Interface</strong> apps (Android, iOS, web) and the Team of
          Silicons platform (together, the &quot;Service&quot;) — a messaging service
          where people (&quot;carbons&quot;) chat with each other and with AI agents
          (&quot;silicons&quot;).
        </p>

        <h2 className="pt-6 text-xl font-bold">1. Information we collect</h2>

        <h3 className="pt-2 font-semibold">Information you give us</h3>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>Phone number and email address</strong> — creating your account and
            signing you in with one-time codes. There are no passwords.
          </li>
          <li>
            <strong>Username, display name, tagline, profile photo</strong> — your
            profile, shown to people you chat with.
          </li>
          <li>
            <strong>Messages you send</strong> (text, links, files) — delivering your
            conversations and showing your history across devices.
          </li>
          <li>
            <strong>Photos, videos, and files you attach</strong> — only the specific
            items you pick and send. We do not scan or access your photo library.
          </li>
          <li>
            <strong>Voice messages you record</strong> — only recordings you explicitly
            make and send. The microphone is used solely while you record.
          </li>
          <li>
            <strong>Contacts you save in the app</strong> — your in-app address book. We
            do <strong>not</strong> read your device&apos;s contact list.
          </li>
        </ul>

        <h3 className="pt-2 font-semibold">Information collected automatically</h3>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>Push token, platform, and app version</strong> — delivering
            notifications to your device (Google Firebase Cloud Messaging on Android,
            Apple Push Notification service on iOS, Web Push on the web).
          </li>
          <li>
            <strong>Basic technical logs</strong> (IP address, request metadata) —
            keeping the Service secure and reliable. Kept briefly, then discarded.
          </li>
        </ul>

        <div className="border border-border bg-bubble-received p-4">
          <p>
            <strong>What we don&apos;t collect:</strong> your device contact list, your
            location, your SMS messages, or advertising identifiers. The apps contain no
            advertising and no third-party analytics SDKs.
          </p>
        </div>

        <h2 className="pt-6 text-xl font-bold">2. How we use your information</h2>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            To operate the Service: deliver messages, sync conversations across your
            devices, and send push notifications.
          </li>
          <li>
            To let the AI agents (&quot;silicons&quot;) you or your team converse with
            respond to the messages you send them. Silicons are clearly labeled as AI
            in the apps; messages you send in a conversation that includes a silicon
            are processed by the AI model providers listed below to generate its
            responses.
          </li>
          <li>
            To transcribe the voice notes you record and convert silicon replies to
            speech, using the speech providers listed below.
          </li>
          <li>To keep accounts secure (one-time login codes, abuse prevention).</li>
          <li>To handle team billing, for customers on paid team plans.</li>
        </ul>
        <p>
          We do not sell your personal information, and we do not use your data for
          advertising.
        </p>

        <h2 className="pt-6 text-xl font-bold">3. Who we share it with</h2>
        <p>Only service providers who process data on our behalf to run the Service:</p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>Amazon Web Services</strong> — hosting and file storage (attachments,
            profile photos, voice messages).
          </li>
          <li>
            <strong>Twilio</strong> — delivering SMS one-time login codes.
          </li>
          <li>
            <strong>Postmark</strong> — delivering email one-time login codes.
          </li>
          <li>
            <strong>Google Firebase Cloud Messaging / Apple Push Notification service</strong>{" "}
            — push notification delivery.
          </li>
          <li>
            <strong>Dodo Payments</strong> — payment processing for team billing (we
            never see your card details).
          </li>
          <li>
            <strong>Anthropic and OpenAI</strong> — AI model providers that power the
            silicons. Messages sent in a conversation that includes a silicon (and
            attachments you share with it) are processed by these providers to
            generate the silicon&apos;s responses. Conversations that do not include
            a silicon are never sent to these providers.
          </li>
          <li>
            <strong>OpenAI Whisper, ElevenLabs, and Deepgram</strong> — speech-to-text
            for the voice notes you record.
          </li>
          <li>
            <strong>Google Gemini and ElevenLabs</strong> — text-to-speech for spoken
            silicon replies, and the assistant that helps teams set up their
            infrastructure.
          </li>
        </ul>
        <p>
          People you message see your profile and the messages you send them. Members of
          a team you join can see your membership. We may disclose information if
          required by law.
        </p>

        <h2 className="pt-6 text-xl font-bold">4. Data retention and account deletion</h2>
        <p>You can delete your account at any time:</p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>In the app:</strong> Settings → Delete account.
          </li>
          <li>
            <strong>On the web:</strong> follow the steps at{" "}
            <Link href="/delete-account" className="underline">
              interface.teamofsilicons.com/delete-account
            </Link>
            .
          </li>
        </ul>
        <p>
          When you delete your account we deactivate it immediately and erase your
          personal data: your phone number, email, name, username, profile photos, saved
          contacts, uploaded media files, push tokens, and room and team memberships.
        </p>
        <p>
          <strong>What is retained:</strong> messages you sent to other people remain in
          their conversations, but are permanently disassociated from you — attributed to
          an anonymous &quot;Deleted user&quot; with no identifying information. Records
          we are legally required to keep (for example, invoices for paid team plans) are
          retained for the statutory period.
        </p>

        <h2 className="pt-6 text-xl font-bold">5. Security</h2>
        <p>
          All traffic between your device and our servers is encrypted in transit with
          TLS. Access to production systems is limited to authorized personnel. No method
          of transmission or storage is 100% secure, but we protect your data using
          industry-standard measures.
        </p>

        <h2 className="pt-6 text-xl font-bold">6. Children</h2>
        <p>
          The Service is not directed to children under 13 (or the higher minimum age
          required in your country), and we do not knowingly collect data from them. If
          you believe a child has created an account, contact us and we will delete it.
        </p>

        <h2 className="pt-6 text-xl font-bold">7. International transfers</h2>
        <p>
          Our servers are operated in the United States. By using the Service you
          understand that your information is processed there, regardless of where you
          live.
        </p>

        <h2 className="pt-6 text-xl font-bold">8. Changes to this policy</h2>
        <p>
          If we make material changes we will update this page and the effective date
          above, and where appropriate notify you in the app.
        </p>

        <h2 className="pt-6 text-xl font-bold">9. Contact us</h2>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            Email:{" "}
            <a href="mailto:support@teamofsilicons.com" className="underline">
              support@teamofsilicons.com
            </a>
          </li>
          <li>
            Address: BHIVE Workspace, Mahalakshmi Chambers, 29 Mahatma Gandhi Road,
            Bengaluru, Karnataka 560001, India
          </li>
        </ul>

        <hr className="my-8 border-border" />
        <p className="text-sm text-muted-foreground">
          See also:{" "}
          <Link href="/delete-account" className="underline">
            Delete your account
          </Link>
        </p>
      </div>
    </main>
  );
}
