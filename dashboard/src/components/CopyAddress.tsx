"use client";

import { useState, type MouseEvent } from "react";
import { type Address, getAddress, isAddress, zeroAddress } from "viem";
import { shortAddr } from "@/utils/format";

type Props = {
  address: string;
  /** Show the full CA instead of 0xabcd…1234. */
  full?: boolean;
  className?: string;
};

/**
 * One-click copy for contract / wallet addresses.
 * Displays a shortened (or full) CA; click copies the checksummed address.
 */
export function CopyAddress({ address, full = false, className = "mono muted" }: Props) {
  const [copied, setCopied] = useState(false);

  if (!address || !isAddress(address) || address.toLowerCase() === zeroAddress) {
    return <span className={className}>{full ? address || "—" : "—"}</span>;
  }

  const checksum = getAddress(address);
  const label = full ? checksum : shortAddr(checksum as Address);

  async function onCopy(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(checksum);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked */
    }
  }

  return (
    <button
      type="button"
      className={`copy-addr ${className}${copied ? " copied" : ""}`}
      onClick={onCopy}
      title={copied ? "Copied!" : `Click to copy ${checksum}`}
      aria-label={copied ? "Address copied" : `Copy address ${checksum}`}
    >
      {label}
      {copied ? <span className="copy-flash" aria-hidden="true"> ✓</span> : null}
    </button>
  );
}
