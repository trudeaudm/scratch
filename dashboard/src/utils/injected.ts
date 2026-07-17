import { createConnector, type CreateConnectorFn } from "wagmi";
import { getAddress, type Address, type Hex } from "viem";

type EthProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

function getEthereum(): EthProvider | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { ethereum?: EthProvider }).ethereum;
}

/** Minimal injected (window.ethereum) connector — no WalletConnect / Coinbase deps. */
export function injected(): CreateConnectorFn {
  return createConnector((config) => {
    const connector = {
      id: "injected",
      name: "Injected",
      type: "injected" as const,

      async setup() {},

      async connect(parameters?: { chainId?: number }) {
        const chainId = parameters?.chainId;
        const provider = getEthereum();
        if (!provider) throw new Error("No injected wallet (window.ethereum)");

        const accounts = (await provider.request({
          method: "eth_requestAccounts",
        })) as string[];
        const account = getAddress(accounts[0] as Address);

        let currentChainId = await connector.getChainId();
        if (chainId && currentChainId !== chainId && connector.switchChain) {
          try {
            await connector.switchChain({ chainId });
            currentChainId = chainId;
          } catch {
            /* stay on current chain */
          }
        }

        return {
          accounts: [account] as readonly Address[],
          chainId: currentChainId,
        };
      },

      async disconnect() {},

      async getAccounts() {
        const provider = getEthereum();
        if (!provider) return [] as Address[];
        const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
        return accounts.map((a) => getAddress(a as Address));
      },

      async getChainId() {
        const provider = getEthereum();
        if (!provider) return config.chains[0].id;
        const hex = (await provider.request({ method: "eth_chainId" })) as Hex;
        return Number.parseInt(hex, 16);
      },

      async getProvider() {
        const provider = getEthereum();
        if (!provider) throw new Error("No injected wallet");
        return provider;
      },

      async isAuthorized() {
        const accounts = await connector.getAccounts();
        return accounts.length > 0;
      },

      async switchChain({ chainId }: { chainId: number }) {
        const provider = getEthereum();
        if (!provider) throw new Error("No injected wallet");
        const chain = config.chains.find((c) => c.id === chainId);
        if (!chain) throw new Error(`Chain ${chainId} not configured`);

        const hexId = `0x${chainId.toString(16)}` as Hex;
        try {
          await provider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: hexId }],
          });
        } catch (e) {
          const err = e as { code?: number };
          if (err.code === 4902) {
            await provider.request({
              method: "wallet_addEthereumChain",
              params: [
                {
                  chainId: hexId,
                  chainName: chain.name,
                  nativeCurrency: chain.nativeCurrency,
                  rpcUrls: chain.rpcUrls.default.http,
                  blockExplorerUrls: chain.blockExplorers
                    ? [chain.blockExplorers.default.url]
                    : undefined,
                },
              ],
            });
          } else {
            throw e;
          }
        }
        return chain;
      },

      onAccountsChanged(accounts: string[]) {
        if (accounts.length === 0) {
          config.emitter.emit("disconnect");
          return;
        }
        config.emitter.emit("change", {
          accounts: accounts.map((a) => getAddress(a as Address)),
        });
      },

      onChainChanged(chain: string | number) {
        const chainId =
          typeof chain === "string" ? Number.parseInt(chain, 16) : Number(chain);
        config.emitter.emit("change", { chainId });
      },

      onDisconnect() {
        config.emitter.emit("disconnect");
      },
    };

    return connector as never;
  });
}
