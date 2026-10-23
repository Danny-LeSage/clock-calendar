package io.github.dannylesage.clockcalendar;

import androidx.annotation.NonNull;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.util.Iterator;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * Sends iCloud CalDAV requests (PROPFIND, REPORT, PUT, DELETE, GET).
 * Android's built-in HTTP client, which Capacitor uses, refuses PROPFIND and
 * REPORT, so these go through OkHttp. Only https requests to icloud.com hosts
 * are allowed.
 */
@CapacitorPlugin(name = "DavHttp")
public class DavHttpPlugin extends Plugin {

    private final OkHttpClient client = new OkHttpClient.Builder()
        .callTimeout(20, TimeUnit.SECONDS)
        .build();

    private static boolean allowed(HttpUrl url) {
        if (url == null || !url.isHttps()) return false;
        String host = url.host();
        return host.equals("icloud.com") || host.endsWith(".icloud.com");
    }

    @PluginMethod
    public void request(PluginCall call) {
        String method = call.getString("method", "GET").toUpperCase();
        HttpUrl url = HttpUrl.parse(call.getString("url", ""));
        if (!allowed(url)) {
            call.reject("iCloud sent an unexpected address.");
            return;
        }

        Request.Builder builder = new Request.Builder().url(url);
        String contentType = null;
        JSObject headers = call.getObject("headers", new JSObject());
        Iterator<String> keys = headers.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            String value = headers.getString(key);
            if (value == null) continue;
            if (key.equalsIgnoreCase("content-type")) contentType = value;
            else builder.header(key, value);
        }

        String body = call.getString("body");
        RequestBody requestBody = null;
        if (body != null) {
            MediaType type = MediaType.parse(contentType != null ? contentType : "application/xml; charset=utf-8");
            requestBody = RequestBody.create(body, type);
        } else if (method.equals("PUT") || method.equals("PROPFIND") || method.equals("REPORT")) {
            requestBody = RequestBody.create(new byte[0], null);
        }
        builder.method(method, requestBody);

        client.newCall(builder.build()).enqueue(new Callback() {
            @Override
            public void onFailure(@NonNull Call c, @NonNull IOException e) {
                call.reject("Couldn't reach iCloud: " + e.getMessage());
            }

            @Override
            public void onResponse(@NonNull Call c, @NonNull Response response) {
                try (Response r = response) {
                    if (!allowed(r.request().url())) {
                        call.reject("iCloud sent an unexpected address.");
                        return;
                    }
                    JSObject out = new JSObject();
                    out.put("status", r.code());
                    out.put("url", r.request().url().toString());
                    out.put("etag", r.header("ETag"));
                    out.put("text", r.body() != null ? r.body().string() : "");
                    call.resolve(out);
                } catch (IOException e) {
                    call.reject("Couldn't read iCloud's answer: " + e.getMessage());
                }
            }
        });
    }
}
