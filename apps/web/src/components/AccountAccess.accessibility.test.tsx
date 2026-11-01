// @vitest-environment jsdom
import type { AccountSecurity } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { fetchAccountSecurity } from "../lib/account-security";
import { authClient } from "../lib/auth";
import { AccountAccess } from "./AccountAccess";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../lib/account-security", () => ({ fetchAccountSecurity: vi.fn() }));
vi.mock("../lib/auth", () => ({ authClient: { deleteUser: vi.fn() } }));

afterEach(() => vi.unstubAllGlobals());

it.each([true, false])(
  "names the account deletion control and opens password confirmation when password changes are %s",
  async (passwordChangeEnabled) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const security: AccountSecurity = {
      hasPassword: true,
      passwordChangeEnabled,
      freshOidcAuth: false,
      ssoLinked: true,
      emailDeletion: true,
      sso: { name: "Example" },
    };
    vi.mocked(fetchAccountSecurity).mockResolvedValue(security);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<AccountAccess />));
      const control = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Delete account"]',
      );
      expect(control).not.toBeNull();
      expect(control?.textContent).toBe("Delete");
      expect(container.querySelector('input[type="password"]')).toBeNull();

      await act(async () => control!.click());
      expect(container.querySelector('label[for="delete-password"]')?.textContent).toBe(
        "Current password",
      );
      expect(container.querySelector('input[type="password"]')?.id).toBe("delete-password");
      expect(container.textContent).not.toContain("Send deletion code");
      expect(authClient.deleteUser).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  },
);
