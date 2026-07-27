import { Aurora } from "@/components/Aurora";
import { Nav } from "@/components/Nav";
import { Hero } from "@/components/Hero";
import { Installation } from "@/components/Installation";
import { WhatIs } from "@/components/WhatIs";
import { Why } from "@/components/Why";
import { Capabilities } from "@/components/Capabilities";
import { HowItWorks } from "@/components/HowItWorks";
import { Examples } from "@/components/Examples";
import { DocsPreview } from "@/components/DocsPreview";
import { Ecosystem } from "@/components/Ecosystem";
import { DesktopApp } from "@/components/DesktopApp";
import { Roadmap } from "@/components/Roadmap";
import { Faq } from "@/components/Faq";
import { Footer } from "@/components/Footer";

export default function Home() {
  return (
    <div className="spotlight relative min-h-screen">
      <Aurora />
      <Nav />
      <main className="relative z-10">
        <Hero />
        <Installation />
        <WhatIs />
        <Why />
        <Capabilities />
        <HowItWorks />
        <Examples />
        <DocsPreview />
        <Ecosystem />
        <DesktopApp />
        <Roadmap />
        <Faq />
      </main>
      <Footer />
    </div>
  );
}
