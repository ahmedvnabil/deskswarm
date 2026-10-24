# Pinned XFCE/TigerVNC desktop index: Linux AMD64 and ARM64.
FROM trycua/xfce-cua@sha256:274eb636f5cf3fc58f705916ee72b7a701270b3877369d08533a385c5325be9b
USER root
ENV PATH="/usr/local/bin:${PATH}"
COPY install-driver.py /tmp/install-driver.py
RUN /usr/bin/python3 /tmp/install-driver.py
COPY driver.conf /tmp/cua-driver.conf
RUN cat /tmp/cua-driver.conf >> /etc/supervisor/supervisord.conf
