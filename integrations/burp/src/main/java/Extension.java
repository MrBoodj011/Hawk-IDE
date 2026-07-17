import burp.api.montoya.BurpExtension;
import burp.api.montoya.MontoyaApi;
import burp.api.montoya.http.handler.HttpHandler;
import burp.api.montoya.http.handler.HttpRequestToBeSent;
import burp.api.montoya.http.handler.HttpResponseReceived;
import burp.api.montoya.http.handler.RequestToBeSentAction;
import burp.api.montoya.http.handler.ResponseReceivedAction;
import burp.api.montoya.http.message.HttpHeader;
import burp.api.montoya.persistence.Preferences;

import javax.swing.BorderFactory;
import javax.swing.Box;
import javax.swing.BoxLayout;
import javax.swing.JButton;
import javax.swing.JCheckBox;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JPasswordField;
import javax.swing.JSpinner;
import javax.swing.JTextArea;
import javax.swing.JTextField;
import javax.swing.SpinnerNumberModel;
import javax.swing.SwingUtilities;
import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Dimension;
import java.awt.FlowLayout;
import java.awt.Font;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

public final class Extension implements BurpExtension {
    private MontoyaApi api;
    private BridgeClient bridge;

    @Override
    public void initialize(MontoyaApi api) {
        this.api = api;
        api.extension().setName("Hawk Burp Companion");

        Config config = Config.load(api.persistence().preferences());
        bridge = new BridgeClient(api, config);
        api.http().registerHttpHandler(new CaptureHandler(bridge));
        api.userInterface().registerSuiteTab("Hawk", buildPanel(config));
        api.extension().registerUnloadingHandler(bridge::close);
        api.logging().logToOutput(
            "Hawk Burp Companion loaded. Capture remains disabled until a local Hawk pairing is saved."
        );
    }

    private JPanel buildPanel(Config initial) {
        JPanel root = new JPanel();
        root.setLayout(new BoxLayout(root, BoxLayout.Y_AXIS));
        root.setBorder(BorderFactory.createEmptyBorder(22, 24, 24, 24));

        JLabel title = new JLabel("HAWK / BURP COMPANION");
        title.setFont(title.getFont().deriveFont(Font.BOLD, 20f));
        JLabel subtitle = new JLabel(
            "Stream explicitly scoped Burp traffic to the local Hawk evidence plane."
        );
        subtitle.setForeground(new Color(130, 145, 165));

        JTextArea pairing = new JTextArea(5, 70);
        pairing.setLineWrap(true);
        pairing.setWrapStyleWord(true);
        pairing.setToolTipText("Paste pairing JSON copied from Hawk Security IDE");
        JTextField url = new JTextField(initial.bridgeUrl(), 44);
        JPasswordField token = new JPasswordField(initial.token(), 44);
        JTextField scope = new JTextField(initial.scope(), 44);
        JCheckBox enabled = new JCheckBox("Enable live capture", initial.enabled());
        JCheckBox suiteScope = new JCheckBox(
            "Capture only requests in Burp Suite scope",
            initial.burpScopeOnly()
        );
        JSpinner rate = new JSpinner(new SpinnerNumberModel(initial.requestsPerSecond(), 1, 500, 1));
        JLabel status = new JLabel("Not connected");
        status.setForeground(new Color(143, 161, 182));
        JLabel counters = new JLabel("Forwarded 0 · Dropped 0");

        pairing.getDocument().addDocumentListener(new SimpleDocumentListener(() -> {
            try {
                Pairing parsed = Pairing.parse(pairing.getText());
                url.setText(parsed.url());
                token.setText(parsed.token());
                status.setText("Pairing parsed. Save and test to verify.");
                status.setForeground(new Color(82, 230, 220));
            } catch (IllegalArgumentException ignored) {
                if (!pairing.getText().isBlank()) {
                    status.setText("Paste the complete Hawk pairing JSON.");
                    status.setForeground(new Color(255, 100, 124));
                }
            }
        }));

        JPanel buttons = new JPanel(new FlowLayout(FlowLayout.LEFT, 0, 0));
        JButton save = new JButton("Save & test");
        JButton test = new JButton("Test only");
        test.setBorder(BorderFactory.createEmptyBorder(8, 16, 8, 16));
        save.setBorder(BorderFactory.createEmptyBorder(8, 16, 8, 16));
        buttons.add(save);
        buttons.add(Box.createRigidArea(new Dimension(8, 1)));
        buttons.add(test);

        Runnable refreshCounters = () -> counters.setText(
            "Forwarded " + bridge.forwarded() + " · Dropped " + bridge.dropped()
        );
        Runnable testConnection = () -> {
            status.setText("Testing local Hawk bridge…");
            bridge.test().whenComplete((message, error) -> SwingUtilities.invokeLater(() -> {
                if (error == null) {
                    status.setText(message);
                    status.setForeground(new Color(82, 230, 220));
                } else {
                    status.setText(safeMessage(error));
                    status.setForeground(new Color(255, 100, 124));
                }
                refreshCounters.run();
            }));
        };
        save.addActionListener(event -> {
            try {
                Config updated = new Config(
                    url.getText().trim(),
                    new String(token.getPassword()),
                    scope.getText().trim(),
                    enabled.isSelected(),
                    suiteScope.isSelected(),
                    (Integer) rate.getValue()
                ).validated();
                updated.save(api.persistence().preferences());
                bridge.update(updated);
                testConnection.run();
            } catch (IllegalArgumentException error) {
                status.setText(error.getMessage());
                status.setForeground(new Color(255, 100, 124));
            }
        });
        test.addActionListener(event -> testConnection.run());

        root.add(title);
        root.add(Box.createRigidArea(new Dimension(1, 5)));
        root.add(subtitle);
        root.add(Box.createRigidArea(new Dimension(1, 26)));
        root.add(section("01 / PAIR WITH HAWK"));
        root.add(labeled("Pairing JSON", pairing));
        root.add(Box.createRigidArea(new Dimension(1, 12)));
        root.add(labeled("Loopback bridge URL", url));
        root.add(Box.createRigidArea(new Dimension(1, 12)));
        root.add(labeled("Pairing token", token));
        root.add(Box.createRigidArea(new Dimension(1, 24)));
        root.add(section("02 / GOVERN CAPTURE"));
        root.add(labeled("Authorized URL scope (regular expression)", scope));
        root.add(Box.createRigidArea(new Dimension(1, 10)));
        root.add(enabled);
        root.add(suiteScope);
        root.add(labeled("Maximum requests per second", rate));
        root.add(Box.createRigidArea(new Dimension(1, 20)));
        root.add(buttons);
        root.add(Box.createRigidArea(new Dimension(1, 14)));
        root.add(status);
        root.add(counters);
        return root;
    }

    private static JPanel section(String text) {
        JPanel row = new JPanel(new BorderLayout());
        JLabel label = new JLabel(text);
        label.setFont(label.getFont().deriveFont(Font.BOLD, 11f));
        label.setForeground(new Color(255, 139, 66));
        row.add(label, BorderLayout.WEST);
        row.setMaximumSize(new Dimension(Integer.MAX_VALUE, 30));
        return row;
    }

    private static JPanel labeled(String label, java.awt.Component field) {
        JPanel panel = new JPanel(new BorderLayout(0, 5));
        panel.add(new JLabel(label), BorderLayout.NORTH);
        panel.add(field, BorderLayout.CENTER);
        panel.setMaximumSize(new Dimension(Integer.MAX_VALUE, field instanceof JTextArea ? 135 : 62));
        return panel;
    }

    private static String safeMessage(Throwable error) {
        Throwable cause = error instanceof java.util.concurrent.CompletionException
            ? error.getCause()
            : error;
        String message = cause == null ? "Unknown bridge error" : cause.getMessage();
        return message == null ? cause.toString() : message;
    }

    private record Pairing(String url, String token) {
        static Pairing parse(String json) {
            String url = extractJsonString(json, "url");
            String token = extractJsonString(json, "token");
            if (url.isBlank() || token.isBlank()) throw new IllegalArgumentException("Invalid pairing JSON");
            return new Pairing(url, token);
        }
    }

    private record Config(
        String bridgeUrl,
        String token,
        String scope,
        boolean enabled,
        boolean burpScopeOnly,
        int requestsPerSecond
    ) {
        private static final String PREFIX = "hawk.companion.";

        static Config load(Preferences preferences) {
            return new Config(
                valueOr(preferences.getString(PREFIX + "url"), "http://127.0.0.1:9999"),
                valueOr(preferences.getString(PREFIX + "token"), ""),
                valueOr(preferences.getString(PREFIX + "scope"), "^https?://"),
                Boolean.TRUE.equals(preferences.getBoolean(PREFIX + "enabled")),
                !Boolean.FALSE.equals(preferences.getBoolean(PREFIX + "burpScopeOnly")),
                valueOr(preferences.getInteger(PREFIX + "rate"), 50)
            );
        }

        Config validated() {
            URI uri;
            try {
                uri = URI.create(bridgeUrl);
            } catch (IllegalArgumentException error) {
                throw new IllegalArgumentException("Bridge URL is invalid.");
            }
            String host = uri.getHost();
            if (
                !"http".equalsIgnoreCase(uri.getScheme()) ||
                !("127.0.0.1".equals(host) || "localhost".equalsIgnoreCase(host) || "::1".equals(host))
            ) {
                throw new IllegalArgumentException("The bridge must be an HTTP loopback URL.");
            }
            if (token.length() < 16) throw new IllegalArgumentException("Paste a valid Hawk token.");
            try {
                Pattern.compile(scope);
            } catch (PatternSyntaxException error) {
                throw new IllegalArgumentException("The URL scope expression is invalid.");
            }
            if (requestsPerSecond < 1 || requestsPerSecond > 500) {
                throw new IllegalArgumentException("Rate limit must be between 1 and 500.");
            }
            return this;
        }

        void save(Preferences preferences) {
            preferences.setString(PREFIX + "url", bridgeUrl);
            preferences.setString(PREFIX + "token", token);
            preferences.setString(PREFIX + "scope", scope);
            preferences.setBoolean(PREFIX + "enabled", enabled);
            preferences.setBoolean(PREFIX + "burpScopeOnly", burpScopeOnly);
            preferences.setInteger(PREFIX + "rate", requestsPerSecond);
        }
    }

    private static final class CaptureHandler implements HttpHandler {
        private final BridgeClient bridge;

        private CaptureHandler(BridgeClient bridge) {
            this.bridge = bridge;
        }

        @Override
        public RequestToBeSentAction handleHttpRequestToBeSent(HttpRequestToBeSent request) {
            return RequestToBeSentAction.continueWith(request);
        }

        @Override
        public ResponseReceivedAction handleHttpResponseReceived(HttpResponseReceived response) {
            bridge.capture(response);
            return ResponseReceivedAction.continueWith(response);
        }
    }

    private static final class BridgeClient implements AutoCloseable {
        private final MontoyaApi api;
        private final ThreadPoolExecutor executor;
        private final HttpClient client;
        private final AtomicLong forwarded = new AtomicLong();
        private final AtomicLong dropped = new AtomicLong();
        private final RateLimiter limiter = new RateLimiter();
        private volatile Config config;

        private BridgeClient(MontoyaApi api, Config config) {
            this.api = api;
            this.config = config;
            this.executor = new ThreadPoolExecutor(
                1,
                2,
                30,
                TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(1_000),
                runnable -> {
                    Thread thread = new Thread(runnable, "hawk-burp-bridge");
                    thread.setDaemon(true);
                    return thread;
                },
                (runnable, ignored) -> dropped.incrementAndGet()
            );
            this.client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(2))
                .executor(executor)
                .build();
        }

        void update(Config config) {
            this.config = config;
            limiter.reset();
        }

        long forwarded() {
            return forwarded.get();
        }

        long dropped() {
            return dropped.get();
        }

        void capture(HttpResponseReceived response) {
            Config current = config;
            if (!current.enabled() || current.token().isBlank()) return;
            var request = response.initiatingRequest();
            if (current.burpScopeOnly() && !request.isInScope()) return;
            if (!Pattern.compile(current.scope()).matcher(request.url()).find()) return;
            if (!limiter.allow(current.requestsPerSecond())) {
                dropped.incrementAndGet();
                return;
            }

            String payload = "{"
                + "\"kind\":\"burp\","
                + "\"id\":" + response.messageId() + ","
                + "\"method\":" + quote(request.method()) + ","
                + "\"url\":" + quote(request.url()) + ","
                + "\"status\":" + response.statusCode() + ","
                + "\"type\":" + quote(response.toolSource().toolType().name().toLowerCase(Locale.ROOT)) + ","
                + "\"requestHeaders\":" + headersJson(request.headers()) + ","
                + "\"responseHeaders\":" + headersJson(response.headers()) + ","
                + "\"timeStart\":" + System.currentTimeMillis() + ","
                + "\"timeEnd\":" + System.currentTimeMillis()
                + "}";
            submit("/ingest", payload).whenComplete((ignored, error) -> {
                if (error == null) forwarded.incrementAndGet();
                else dropped.incrementAndGet();
            });
        }

        CompletableFuture<String> test() {
            Config current = config.validated();
            HttpRequest request = HttpRequest.newBuilder(URI.create(current.bridgeUrl() + "/status"))
                .timeout(Duration.ofSeconds(3))
                .header("X-Hawk-Token", current.token())
                .GET()
                .build();
            return client.sendAsync(request, HttpResponse.BodyHandlers.ofString())
                .thenApply(response -> {
                    if (response.statusCode() != 200) {
                        throw new IllegalStateException("Hawk bridge returned " + response.statusCode());
                    }
                    return "Connected to local Hawk evidence plane.";
                });
        }

        private CompletableFuture<Void> submit(String path, String payload) {
            Config current = config;
            HttpRequest request = HttpRequest.newBuilder(URI.create(current.bridgeUrl() + path))
                .timeout(Duration.ofSeconds(4))
                .header("Content-Type", "application/json")
                .header("X-Hawk-Source", "burp-extension")
                .header("X-Hawk-Token", current.token())
                .POST(HttpRequest.BodyPublishers.ofString(payload))
                .build();
            return client.sendAsync(request, HttpResponse.BodyHandlers.discarding())
                .thenAccept(response -> {
                    if (response.statusCode() < 200 || response.statusCode() >= 300) {
                        throw new IllegalStateException("Hawk bridge returned " + response.statusCode());
                    }
                })
                .exceptionally(error -> {
                    api.logging().logToError("Hawk bridge: " + safeMessage(error));
                    throw new java.util.concurrent.CompletionException(error);
                });
        }

        @Override
        public void close() {
            executor.shutdownNow();
        }
    }

    private static final class RateLimiter {
        private long windowStartedAt = System.nanoTime();
        private int count = 0;

        synchronized boolean allow(int maximum) {
            long now = System.nanoTime();
            if (now - windowStartedAt >= TimeUnit.SECONDS.toNanos(1)) {
                windowStartedAt = now;
                count = 0;
            }
            if (count >= maximum) return false;
            count += 1;
            return true;
        }

        synchronized void reset() {
            windowStartedAt = System.nanoTime();
            count = 0;
        }
    }

    @FunctionalInterface
    private interface ChangeListener {
        void changed();
    }

    private static final class SimpleDocumentListener implements javax.swing.event.DocumentListener {
        private final ChangeListener listener;

        private SimpleDocumentListener(ChangeListener listener) {
            this.listener = listener;
        }

        @Override
        public void insertUpdate(javax.swing.event.DocumentEvent event) {
            listener.changed();
        }

        @Override
        public void removeUpdate(javax.swing.event.DocumentEvent event) {
            listener.changed();
        }

        @Override
        public void changedUpdate(javax.swing.event.DocumentEvent event) {
            listener.changed();
        }
    }

    private static String headersJson(List<HttpHeader> headers) {
        StringBuilder output = new StringBuilder("[");
        int count = 0;
        for (HttpHeader header : headers) {
            if (count >= 256) break;
            if (count++ > 0) output.append(',');
            String value = isSensitiveHeader(header.name()) ? "REDACTED" : cap(header.value(), 8_192);
            output.append("{\"name\":")
                .append(quote(cap(header.name(), 256)))
                .append(",\"value\":")
                .append(quote(value))
                .append('}');
        }
        return output.append(']').toString();
    }

    private static boolean isSensitiveHeader(String name) {
        String normalized = name.toLowerCase(Locale.ROOT);
        return normalized.equals("authorization")
            || normalized.equals("cookie")
            || normalized.equals("set-cookie")
            || normalized.equals("proxy-authorization")
            || normalized.equals("x-api-key");
    }

    private static String quote(String value) {
        StringBuilder output = new StringBuilder(value.length() + 16).append('"');
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            switch (character) {
                case '"' -> output.append("\\\"");
                case '\\' -> output.append("\\\\");
                case '\b' -> output.append("\\b");
                case '\f' -> output.append("\\f");
                case '\n' -> output.append("\\n");
                case '\r' -> output.append("\\r");
                case '\t' -> output.append("\\t");
                default -> {
                    if (character < 0x20) output.append(String.format("\\u%04x", (int) character));
                    else output.append(character);
                }
            }
        }
        return output.append('"').toString();
    }

    private static String extractJsonString(String json, String key) {
        Pattern pattern = Pattern.compile(
            "\"" + Pattern.quote(key) + "\"\\s*:\\s*\"((?:\\\\.|[^\"\\\\])*)\""
        );
        var match = pattern.matcher(Objects.requireNonNullElse(json, ""));
        if (!match.find()) return "";
        return match.group(1)
            .replace("\\\"", "\"")
            .replace("\\\\", "\\")
            .replace("\\/", "/");
    }

    private static String cap(String value, int maximum) {
        if (value == null) return "";
        return value.length() <= maximum ? value : value.substring(0, maximum);
    }

    private static String valueOr(String value, String fallback) {
        return value == null ? fallback : value;
    }

    private static int valueOr(Integer value, int fallback) {
        return value == null ? fallback : value;
    }
}
