
const titulo = document.querySelector(".titulo");

window.addEventListener("mousemove", (e) => {
    const x = (window.innerWidth - e.pageX * 2) / 80;
    const y = (window.innerHeight - e.pageY * 2) / 80;
    titulo.style.transform = `translate(${x}px, ${y}px)`;
});


const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add("visible");
        }
    });
}, { threshold: 0.2 });

document.querySelectorAll(".card").forEach(card => {
    card.classList.add("hidden");
    observer.observe(card);
});


const navbar = document.querySelector(".navbar");

window.addEventListener("scroll", () => {
    if (window.scrollY > 100) {
        navbar.classList.add("navbar-small");
    } else {
        navbar.classList.remove("navbar-small");
    }
});


document.querySelectorAll(".navbar a").forEach(link => {
    link.addEventListener("mouseover", () => {
        link.style.letterSpacing = "1.5px";
    });

    link.addEventListener("mouseout", () => {
        link.style.letterSpacing = "0px";
    });
});
