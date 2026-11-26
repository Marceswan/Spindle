import { createDataSDK } from "@salesforce/platform-sdk";

const PROFILE_URL = "/services/apexrest/portal/profile";

export function Login(): JSX.Element {
  async function submit(email: string, id: string): Promise<void> {
    const sdk = await createDataSDK();
    await sdk.fetch!("/services/apexrest/auth/login", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
    await sdk.fetch!(`/services/apexrest/auth/session/${id}`);
    await sdk.fetch!(PROFILE_URL);
    await sdk.fetch!("/services/apexrest/unknown/thing");
  }
  return <button onClick={() => submit("a@b.c", "1")}>Log in</button>;
}
