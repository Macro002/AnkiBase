package io.github.ankibase;

/** The app's core (ios/engine, Rust): Anki's engine with the collection on this phone,
 *  serving the web UI on 127.0.0.1 (see ios/engine/src/android.rs). */
final class Core {
    static {
        System.loadLibrary("ankibase_engine");
    }

    /** Starts the core once per process; returns {"port", "token"} or {"error"} as JSON. */
    static native String start(String configJson);

    private Core() {}
}
