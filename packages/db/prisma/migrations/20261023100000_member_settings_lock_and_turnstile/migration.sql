-- Owner-managed member settings, shared owner models and voice, and Turnstile on signup.
ALTER TABLE "deployment_settings" ADD COLUMN "lockMemberSettings" BOOLEAN;
ALTER TABLE "deployment_settings" ADD COLUMN "shareOwnerModels" BOOLEAN;
ALTER TABLE "deployment_settings" ADD COLUMN "turnstileEnabled" BOOLEAN;
ALTER TABLE "deployment_settings" ADD COLUMN "turnstileSiteKey" TEXT;
ALTER TABLE "deployment_settings" ADD COLUMN "turnstileSecretCipher" TEXT;
