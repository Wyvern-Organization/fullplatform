from manim import *


class MythOSAnnouncement(Scene):
    """4K/60 motion-graphics plates for the MythOS announcement edit."""

    def construct(self):
        self.camera.background_color = "#060711"
        background = ImageMobject("data/wallpapers/neon-spectrum.png")
        background.set_height(config.frame_height)
        background.set_width(config.frame_width)
        veil = Rectangle(
            width=config.frame_width,
            height=config.frame_height,
            fill_color="#05050C",
            fill_opacity=0.64,
            stroke_width=0,
        )
        top_rule = Line(LEFT * 6.7, RIGHT * 6.7, color="#54E8FF", stroke_width=2)
        top_rule.to_edge(UP, buff=0.62)
        eyebrow = Text(
            "Introducing", font="Ubuntu Sans", weight=BOLD,
            font_size=27, color="#9BEFFF",
        ).next_to(top_rule, DOWN, buff=0.28).align_to(top_rule, LEFT)
        mark = VGroup(
            Text("M", font="Ubuntu Sans", weight=BOLD, font_size=36, color="#FFFFFF"),
            Dot(radius=0.055, color="#F54BFF"),
        ).arrange(RIGHT, buff=0.1).to_corner(UR, buff=0.62)

        wordmark = Text(
            "MythOS", font="Ubuntu Sans", weight=BOLD,
            font_size=136, color="#FFFFFF",
        )
        wordmark.move_to(UP * 0.48)
        glow = wordmark.copy().set_color("#B5F6FF").set_opacity(0.22).scale(1.045)
        descriptor = Text(
            "Debian-based desktop OS", font="Ubuntu Sans", weight=BOLD,
            font_size=29, color="#A6EAFF",
        ).next_to(wordmark, DOWN, buff=0.30)

        self.add(background, veil)
        self.play(FadeIn(top_rule, shift=RIGHT * 0.7), FadeIn(eyebrow, shift=RIGHT * 0.4), FadeIn(mark), run_time=0.55)
        self.play(FadeIn(glow, scale=0.92), FadeIn(wordmark, scale=0.92), run_time=0.7)
        self.play(FadeIn(descriptor, shift=UP * 0.16), run_time=0.4)
        self.wait(1.75)
        self.play(FadeOut(wordmark, shift=UP * 0.18), FadeOut(glow), FadeOut(descriptor, shift=UP * 0.12), run_time=0.48)

        statement = Text(
            "A computer,\nnot a Linux hobby.", font="Ubuntu Sans", weight=BOLD,
            font_size=76, color="#FFFFFF", line_spacing=0.88,
        ).move_to(UP * 0.20)
        accent = Rectangle(width=0.10, height=1.52, fill_color="#F34CFF", fill_opacity=1, stroke_width=0)
        accent.next_to(statement, LEFT, buff=0.45)
        detail = Text(
            "Designed to make the essentials feel simple.", font="Ubuntu Sans",
            font_size=32, color="#C9D3E8",
        ).next_to(statement, DOWN, buff=0.52).align_to(statement, LEFT)
        self.play(GrowFromCenter(accent), FadeIn(statement, shift=RIGHT * 0.18), run_time=0.6)
        self.play(FadeIn(detail, shift=UP * 0.16), run_time=0.4)
        self.wait(2.15)
        self.play(FadeOut(statement, shift=UP * 0.15), FadeOut(detail), FadeOut(accent), run_time=0.45)

        headline = Text("A desktop that has your back.", font="Ubuntu Sans", weight=BOLD, font_size=57, color="#FFFFFF")
        headline.move_to(UP * 2.18)
        items = [
            ("Updates", "Safer, offline-ready changes"),
            ("Recovery", "Rollback when you need it"),
            ("Compatibility", "Windows apps, thoughtfully handled"),
        ]
        cards = VGroup()
        for title, body in items:
            card = RoundedRectangle(width=10.7, height=1.12, corner_radius=0.14, fill_color="#101528", fill_opacity=0.85, stroke_color="#4E5D86", stroke_opacity=0.75, stroke_width=1.5)
            title_text = Text(title, font="Ubuntu Sans", weight=BOLD, font_size=26, color="#9AF0FF").move_to(card.get_left() + RIGHT * 1.65)
            body_text = Text(body, font="Ubuntu Sans", font_size=28, color="#F1F4FC").move_to(card.get_left() + RIGHT * 6.65)
            cards.add(VGroup(card, title_text, body_text))
        cards.arrange(DOWN, buff=0.23).move_to(DOWN * 0.18)
        self.play(FadeIn(headline, shift=UP * 0.18), run_time=0.5)
        self.play(LaggedStart(*[FadeIn(card, shift=RIGHT * 0.35) for card in cards], lag_ratio=0.22), run_time=1.0)
        self.wait(2.2)
        self.play(FadeOut(headline, shift=UP * 0.12), FadeOut(cards, shift=LEFT * 0.25), run_time=0.5)

        close_title = Text("MythOS", font="Ubuntu Sans", weight=BOLD, font_size=122, color="#FFFFFF")
        close_title.move_to(UP * 0.35)
        close_line = Text("A computer, not a Linux hobby.", font="Ubuntu Sans", font_size=35, color="#B9EFFF")
        close_line.next_to(close_title, DOWN, buff=0.33)
        pulse = Circle(radius=2.42, color="#A244FF", stroke_width=3).set_opacity(0.55)
        pulse.stretch(1.9, 0).move_to(close_title)
        self.play(Create(pulse), FadeIn(close_title, scale=0.94), run_time=0.7)
        self.play(FadeIn(close_line, shift=UP * 0.12), run_time=0.4)
        self.wait(2.2)
        self.play(FadeOut(VGroup(top_rule, eyebrow, mark, pulse, close_title, close_line)), run_time=0.65)
