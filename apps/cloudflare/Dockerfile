FROM cloudflare/sandbox:0.13.0-next.776.1-python

USER root

RUN apt-get update \
  && apt-get install --no-install-recommends -y util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system runner \
  && useradd --system --gid runner --home-dir /tmp/ocpa-home --shell /usr/sbin/nologin runner \
  && install -d --owner=root --group=root --mode=0755 /opt/oc-port-agent

COPY --chown=root:root container/verify.py /opt/oc-port-agent/verify.py

RUN chmod 0555 /opt/oc-port-agent/verify.py
