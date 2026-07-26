"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import type { Address } from "viem";
import { assertSessionAccount } from "@/utils/writeGuards";

/**
 * Captures the account at connect time and guards writes against mid-session
 * wallet switches (MetaMask account change that wagmi hasn't reconciled yet).
 */
export function useWalletSession(expectedRole: string) {
  const { address, isConnected } = useAccount();
  const [sessionAccount, setSessionAccount] = useState<Address | null>(null);
  const prevConnected = useRef(false);

  useEffect(() => {
    if (isConnected && address) {
      // Capture on transition into connected, or first address after connect.
      if (!prevConnected.current || !sessionAccount) {
        setSessionAccount(address);
      }
      prevConnected.current = true;
    } else if (!isConnected) {
      prevConnected.current = false;
      setSessionAccount(null);
    }
  }, [isConnected, address, sessionAccount]);

  const assertReadyForWrite = useCallback(async () => {
    if (!isConnected) {
      return {
        ok: false as const,
        error: `Wallet not connected — connect as ${expectedRole}`,
      };
    }
    return assertSessionAccount({
      expectedRole,
      sessionAccount,
      wagmiAddress: address,
    });
  }, [isConnected, sessionAccount, address, expectedRole]);

  return {
    expectedRole,
    sessionAccount,
    assertReadyForWrite,
  };
}
