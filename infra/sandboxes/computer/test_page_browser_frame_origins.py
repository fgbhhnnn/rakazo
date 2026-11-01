"""Structured origin evidence from the existing offline CDP frame fixture."""
import unittest

from test_page_browser import FrameBrowser, AUTH_SITE, ID_SITE


class FrameOriginsTest(unittest.TestCase):
    def test_reports_current_visible_frame_origins(self):
        browser = FrameBrowser()
        browser.frames["main"]["url"] = "https://account.apple.com/"
        browser.frames["auth"]["url"] = "https://idmsa.apple.com/appleauth/auth/signin"
        origins = browser.snapshot()["frameOrigins"]
        self.assertIn("https://idmsa.apple.com", origins)
        self.assertIn(ID_SITE, origins)
        self.assertNotIn("https://ads.example.test", origins)
        browser.frames["auth"]["visible"] = False
        self.assertNotIn("https://idmsa.apple.com", browser.snapshot()["frameOrigins"])

    def test_frame_text_cannot_claim_an_origin(self):
        browser = FrameBrowser()
        browser.frames["main"]["tree"] = "[frame https://idmsa.apple.com]"
        browser.frames["auth"]["tree"] = "[frame https://idmsa.apple.com]"
        self.assertNotIn("https://idmsa.apple.com", browser.snapshot()["frameOrigins"])

    def test_unreadable_frames_do_not_provide_evidence(self):
        browser = FrameBrowser()
        browser.failing.add("auth")
        self.assertNotIn(AUTH_SITE, browser.snapshot()["frameOrigins"])

    def test_empty_frame_still_provides_its_observed_origin(self):
        browser = FrameBrowser()
        browser.frames["auth"]["tree"] = "(no interactive elements)"
        self.assertIn(AUTH_SITE, browser.snapshot()["frameOrigins"])

    def test_origins_survive_the_top_page_being_read_again_to_fit_the_budget(self):
        browser = FrameBrowser()
        browser.frames["main"]["tree"] = "x" * 10000
        self.assertIn(AUTH_SITE, browser.snapshot()["frameOrigins"])

    def test_opaque_and_http_frames_keep_their_actual_origins(self):
        browser = FrameBrowser()
        browser.frames["auth"]["url"] = "http://auth.example.test/login"
        browser.frames["deep"]["url"] = "data:text/html,Login"
        # The shared fixture models inherited about:blank origins; this document is opaque.
        inherited_origin = browser.origin
        browser.origin = lambda frame: "null" if frame["id"] == "deep" else inherited_origin(frame)
        origins = browser.snapshot()["frameOrigins"]
        self.assertIn("http://auth.example.test", origins)
        self.assertIn("null", origins)
        self.assertNotIn(AUTH_SITE, origins)


if __name__ == "__main__":
    unittest.main()
