import type { Metadata } from "next"
import { AppShell } from "@/components/app-shell"
import { LegalLayout, P, UL, LI, Strong, InlineLink } from "@/components/legal-layout"

export const metadata: Metadata = {
  title: "Privacy Policy | Corgi",
  description:
    "What Corgi collects to run community feed governance, how votes stay private while outcomes stay public, and your data rights.",
  alternates: { canonical: "/privacy/" },
}

const SECTIONS = [
  {
    id: "overview",
    heading: "Overview",
    body: (
      <>
        <P>Corgi is a community-governed Bluesky feed. This Privacy Policy explains what data we collect, how we use it, and your rights. We collect the minimum necessary to operate the feed and respect community governance.</P>
        <P>Corgi connects via Bluesky app passwords. We never receive your main Bluesky password, and you can revoke access at any time from your Bluesky settings.</P>
      </>
    ),
  },
  {
    id: "data-collected",
    heading: "Data we collect",
    body: (
      <>
        <P>Depending on whether you register interest, sign in or participate in governance, we collect:</P>
        <UL>
          <LI><Strong>Your Bluesky DID and handle</Strong> — used to identify your account and associate your vote.</LI>
          <LI><Strong>Vote preferences</Strong> — weight sliders, keyword preferences, topic preferences. These are stored per governance round and used solely to calculate aggregated community weights.</LI>
          <LI><Strong>Research consent status</Strong> — whether you have opted in, opted out, or not yet decided. Stored with a timestamp and version number.</LI>
          <LI><Strong>Session information</Strong> — a server-side session used to authenticate your requests. Expires when you sign out or revoke your app password.</LI>
          <LI><Strong>Contact interest</Strong> — your email, optional Bluesky handle, selected interests, optional note and contact permission are stored separately from voting applications. We use them to follow up about your selected interests, not as research participation or voting approval. Contact hello@corgi.network to request deletion.</LI>
          <LI><Strong>Waitlist submissions</Strong> — the Bluesky handle and optional note you provide when requesting pilot voting access. The request is retained after it is approved or rejected as part of the governance record; contact us to request its deletion.</LI>
        </UL>
        <P>We do <Strong>not</Strong> collect your Bluesky password, your post content, your social graph, or any off-platform behaviour.</P>
      </>
    ),
  },
  {
    id: "how-used",
    heading: "How we use your data",
    body: (
      <>
        <UL>
          <LI><Strong>Feed governance</Strong> — your votes are aggregated (never exposed individually) to set feed ranking weights for each round.</LI>
          <LI><Strong>Audit trail</Strong> — operator actions (not participant votes) are logged in the public audit log, including the operator&rsquo;s DID.</LI>
          <LI><Strong>Research (opt-in only)</Strong> — if you have consented, anonymised interaction data may be shared with academic research partners studying community-governed recommendation systems.</LI>
        </UL>
        <P>We do not sell, rent, or share your personal data with third parties for advertising or commercial purposes.</P>
      </>
    ),
  },
  {
    id: "public-data",
    heading: "What is publicly visible",
    body: (
      <>
        <P>Corgi is built on a transparency principle. The following is always public:</P>
        <UL>
          <LI>The aggregated weights applied each round (not individual votes).</LI>
          <LI>The operator audit log (operator DID, action type, timestamp — not vote data).</LI>
          <LI>Per-post score breakdowns (the math behind why any Corgi-scored post ranked as it did).</LI>
        </UL>
        <P><Strong>Your individual vote is never public.</Strong> Aggregate statistics (e.g. total vote count, participation rate) may be surfaced on the dashboard, but cannot be traced back to you.</P>
      </>
    ),
  },
  {
    id: "retention",
    heading: "Data retention",
    body: (
      <>
        <P>Governance votes are retained per round and archived when a round closes. We retain historical round data indefinitely to support the audit trail. You may request deletion of your participation data by contacting us.</P>
        <P>Contact-interest records do not expire automatically. We retain them unless you request deletion. You can also ask us to stop contacting you about your selected interests.</P>
        <P>Session data is deleted on sign-out or app password revocation.</P>
      </>
    ),
  },
  {
    id: "rights",
    heading: "Your rights",
    body: (
      <>
        <P>Depending on your jurisdiction, you may have the right to:</P>
        <UL>
          <LI>Access the personal data we hold about you.</LI>
          <LI>Request correction of inaccurate data.</LI>
          <LI>Request deletion of your contact-interest record, participation data and waitlist submission.</LI>
          <LI>Withdraw permission for contact-interest emails at any time by contacting us.</LI>
          <LI>Withdraw research consent at any time (this does not affect your ability to vote).</LI>
          <LI>Object to or restrict certain processing.</LI>
        </UL>
        <P>To exercise any of these rights, email <InlineLink href="mailto:hello@corgi.network">hello@corgi.network</InlineLink>.</P>
      </>
    ),
  },
  {
    id: "research-consent",
    heading: "Research consent",
    body: (
      <>
        <P>Research participation is entirely optional and independent of feed governance. If you consent:</P>
        <UL>
          <LI>Anonymised interaction data (not your DID or handle) may be shared with academic research partners.</LI>
          <LI>Your consent is versioned and timestamped. You can view your current consent status in your account settings.</LI>
          <LI>You can withdraw consent at any time by emailing <InlineLink href="mailto:hello@corgi.network">hello@corgi.network</InlineLink> or through the in-product consent screen.</LI>
        </UL>
      </>
    ),
  },
  {
    id: "security",
    heading: "Security",
    body: (
      <>
        <P>We use industry-standard practices to protect your data, including encrypted sessions and parameterised database queries. We do not store your Bluesky app password — only a server-side session token, which is revocable at any time.</P>
        <P>If you discover a security issue, please disclose it responsibly to <InlineLink href="mailto:hello@corgi.network">hello@corgi.network</InlineLink>.</P>
      </>
    ),
  },
  {
    id: "changes",
    heading: "Changes to this policy",
    body: (
      <>
        <P>We may update this Privacy Policy. Material changes will be announced on the dashboard. The &ldquo;Last updated&rdquo; date at the top reflects the most recent version.</P>
        <P>Continued use of the Service after a policy update constitutes acceptance of the revised policy. If we make a material change to how we handle research data, we will re-request your consent.</P>
      </>
    ),
  },
]

export default function PrivacyPage() {
  return (
    <AppShell user={null}>
      <LegalLayout
        title="Privacy Policy"
        lastUpdated="28 September 2026"
        sections={SECTIONS}
        backHref="/"
        backLabel="Back to home"
      />
    </AppShell>
  )
}
