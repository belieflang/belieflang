use async_trait::async_trait;
use std::collections::HashMap;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

#[async_trait]
pub trait HttpTransport: Send + Sync {
    async fn send(
        &self,
        url: &str,
        headers: &HashMap<String, String>,
        body: &str,
        timeout: Option<Duration>,
    ) -> Result<HttpResponse, String>;
}

pub struct ReqwestTransport {
    client: reqwest::Client,
}

impl Default for ReqwestTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl ReqwestTransport {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }
}

#[async_trait]
impl HttpTransport for ReqwestTransport {
    async fn send(
        &self,
        url: &str,
        headers: &HashMap<String, String>,
        body: &str,
        timeout: Option<Duration>,
    ) -> Result<HttpResponse, String> {
        let mut builder = self.client.post(url);

        for (k, v) in headers {
            builder = builder.header(k, v);
        }

        if let Some(t) = timeout {
            builder = builder.timeout(t);
        }

        let resp = builder
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let status = resp.status().as_u16();
        let body_str = resp.text().await.map_err(|e| e.to_string())?;

        Ok(HttpResponse {
            status,
            body: body_str,
        })
    }
}

pub struct MockTransport<F>
where
    F: Fn(&str, &HashMap<String, String>, &str) -> Result<HttpResponse, String> + Send + Sync,
{
    handler: F,
}

impl<F> MockTransport<F>
where
    F: Fn(&str, &HashMap<String, String>, &str) -> Result<HttpResponse, String> + Send + Sync,
{
    pub fn new(handler: F) -> Self {
        Self { handler }
    }
}

#[async_trait]
impl<F> HttpTransport for MockTransport<F>
where
    F: Fn(&str, &HashMap<String, String>, &str) -> Result<HttpResponse, String> + Send + Sync,
{
    async fn send(
        &self,
        url: &str,
        headers: &HashMap<String, String>,
        body: &str,
        _timeout: Option<Duration>,
    ) -> Result<HttpResponse, String> {
        (self.handler)(url, headers, body)
    }
}
