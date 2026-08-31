import type { Metadata } from "next";
import { Battle } from "@/components/battle/Battle";
import { breadcrumbJsonLd, DEFAULT_OG_IMAGE } from "@/lib/seo";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Battle",
  description:
    "Run one prompt across many models and providers, compare voxel builds side by side, and export the winners.",
  keywords: [
    "ai model comparison",
    "llm battle",
    "voxel build comparison",
    "multi model benchmark",
  ],
  alternates: {
    canonical: "/battle",
  },
  openGraph: {
    title: "MineBench Battle | Multi-model comparison",
    description:
      "Run one prompt across many models and providers, compare voxel builds side by side, and export the winners.",
    url: "/battle",
    images: [{ url: DEFAULT_OG_IMAGE, alt: "MineBench battle multi-model comparison" }],
  },
  twitter: {
    title: "MineBench Battle | Multi-model comparison",
    description:
      "Run one prompt across many models and providers, compare voxel builds side by side, and export the winners.",
    images: [DEFAULT_OG_IMAGE],
  },
};

const breadcrumbData = breadcrumbJsonLd([
  { name: "Arena", path: "/" },
  { name: "Battle", path: "/battle" },
]);

export default function BattlePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbData) }}
      />
      <Battle />
    </>
  );
}
