import QtQuick 2.15;
import calamares.slideshow 1.0;

Presentation {
    id: presentation

    Timer {
        interval: 6500
        running: presentation.activatedInCalamares
        repeat: true
        onTriggered: presentation.goToNextSlide()
    }

    Slide {
        centeredText: qsTr("Built for the things you do — not for managing an operating system.")
    }
    Slide {
        centeredText: qsTr("Updates install offline with a restore point ready if anything goes wrong.")
    }
    Slide {
        centeredText: qsTr("Flatpak apps and Windows apps stay isolated from the system and from each other.")
    }
    Slide {
        centeredText: qsTr("Recovery, hardware checks, migration, and backup are available without a terminal.")
    }

    function onActivate() {
        presentation.currentSlide = 0;
    }
    function onLeave() {}
}

